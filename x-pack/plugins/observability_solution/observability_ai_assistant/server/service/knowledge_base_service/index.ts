/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import { errors } from '@elastic/elasticsearch';
import { serverUnavailable, gatewayTimeout, badRequest } from '@hapi/boom';
import type { ElasticsearchClient, IUiSettingsClient } from '@kbn/core/server';
import type { Logger } from '@kbn/logging';
import type { TaskManagerStartContract } from '@kbn/task-manager-plugin/server';
import pLimit from 'p-limit';
import pRetry from 'p-retry';
import { map, orderBy } from 'lodash';
import { encode } from 'gpt-tokenizer';
import { MlTrainedModelDeploymentNodesStats } from '@elastic/elasticsearch/lib/api/types';
import {
  INDEX_QUEUED_DOCUMENTS_TASK_ID,
  INDEX_QUEUED_DOCUMENTS_TASK_TYPE,
  resourceNames,
} from '..';
import {
  Instruction,
  KnowledgeBaseEntry,
  KnowledgeBaseEntryRole,
  KnowledgeBaseType,
} from '../../../common/types';
import { getAccessQuery } from '../util/get_access_query';
import { getCategoryQuery } from '../util/get_category_query';
import { recallFromConnectors } from './recall_from_connectors';

interface Dependencies {
  esClient: { asInternalUser: ElasticsearchClient };
  logger: Logger;
  taskManagerStart: TaskManagerStartContract;
  getModelId: () => Promise<string>;
  enabled: boolean;
}

export interface RecalledEntry {
  id: string;
  text: string;
  score: number | null;
  is_correction?: boolean;
  labels?: Record<string, string>;
}

function isModelMissingOrUnavailableError(error: Error) {
  return (
    error instanceof errors.ResponseError &&
    (error.body?.error?.type === 'resource_not_found_exception' ||
      error.body?.error?.type === 'status_exception')
  );
}
function isCreateModelValidationError(error: Error) {
  return (
    error instanceof errors.ResponseError &&
    error.statusCode === 400 &&
    error.body?.error?.type === 'action_request_validation_exception'
  );
}
function throwKnowledgeBaseNotReady(body: any) {
  throw serverUnavailable(`Knowledge base is not ready yet`, body);
}

export enum KnowledgeBaseEntryOperationType {
  Index = 'index',
  Delete = 'delete',
}

interface KnowledgeBaseDeleteOperation {
  type: KnowledgeBaseEntryOperationType.Delete;
  doc_id?: string;
  labels?: Record<string, string>;
}

interface KnowledgeBaseIndexOperation {
  type: KnowledgeBaseEntryOperationType.Index;
  document: KnowledgeBaseEntry;
}

export type KnowledgeBaseEntryOperation =
  | KnowledgeBaseDeleteOperation
  | KnowledgeBaseIndexOperation;

export class KnowledgeBaseService {
  private hasSetup: boolean = false;

  private _queue: KnowledgeBaseEntryOperation[] = [];

  constructor(private readonly dependencies: Dependencies) {
    this.ensureTaskScheduled();
  }

  setup = async () => {
    if (!this.dependencies.enabled) {
      return;
    }
    const elserModelId = await this.dependencies.getModelId();

    const retryOptions = { factor: 1, minTimeout: 10000, retries: 12 };
    const getModelInfo = async () => {
      return await this.dependencies.esClient.asInternalUser.ml.getTrainedModels({
        model_id: elserModelId,
        include: 'definition_status',
      });
    };

    const isModelInstalledAndReady = async () => {
      try {
        const getResponse = await getModelInfo();
        this.dependencies.logger.debug(
          () => 'Model definition status:\n' + JSON.stringify(getResponse.trained_model_configs[0])
        );

        return Boolean(getResponse.trained_model_configs[0]?.fully_defined);
      } catch (error) {
        if (isModelMissingOrUnavailableError(error)) {
          return false;
        }

        throw error;
      }
    };

    const installModelIfDoesNotExist = async () => {
      const modelInstalledAndReady = await isModelInstalledAndReady();
      if (!modelInstalledAndReady) {
        await installModel();
      }
    };

    const installModel = async () => {
      this.dependencies.logger.info(`Installing ${elserModelId} model`);
      try {
        await this.dependencies.esClient.asInternalUser.ml.putTrainedModel(
          {
            model_id: elserModelId,
            input: {
              field_names: ['text_field'],
            },
            wait_for_completion: true,
          },
          { requestTimeout: '20m' }
        );
      } catch (error) {
        if (isCreateModelValidationError(error)) {
          throw badRequest(error);
        } else {
          throw error;
        }
      }
      this.dependencies.logger.info(`Finished installing ${elserModelId} model`);
    };

    const pollForModelInstallCompleted = async () => {
      await pRetry(async () => {
        this.dependencies.logger.info(`Polling installation of ${elserModelId} model`);
        const modelInstalledAndReady = await isModelInstalledAndReady();
        if (!modelInstalledAndReady) {
          throwKnowledgeBaseNotReady({
            message: 'Model is not fully defined',
          });
        }
      }, retryOptions);
    };
    await installModelIfDoesNotExist();
    await pollForModelInstallCompleted();

    try {
      await this.dependencies.esClient.asInternalUser.ml.startTrainedModelDeployment({
        model_id: elserModelId,
        wait_for: 'fully_allocated',
      });
    } catch (error) {
      this.dependencies.logger.debug(`Error starting ${elserModelId} model deployment`);
      this.dependencies.logger.debug(error);
      if (!isModelMissingOrUnavailableError(error)) {
        throw error;
      }
    }

    await pRetry(async () => {
      const response = await this.dependencies.esClient.asInternalUser.ml.getTrainedModelsStats({
        model_id: elserModelId,
      });

      const isReady = response.trained_model_stats.some((stats) =>
        (stats.deployment_stats?.nodes as unknown as MlTrainedModelDeploymentNodesStats[]).some(
          (node) => node.routing_state.routing_state === 'started'
        )
      );

      if (isReady) {
        return Promise.resolve();
      }

      this.dependencies.logger.debug(`${elserModelId} model is not allocated yet`);
      this.dependencies.logger.debug(() => JSON.stringify(response));

      throw gatewayTimeout();
    }, retryOptions);

    this.dependencies.logger.info(`${elserModelId} model is ready`);
    this.ensureTaskScheduled();
  };

  private ensureTaskScheduled() {
    if (!this.dependencies.enabled) {
      return;
    }
    this.dependencies.taskManagerStart
      .ensureScheduled({
        taskType: INDEX_QUEUED_DOCUMENTS_TASK_TYPE,
        id: INDEX_QUEUED_DOCUMENTS_TASK_ID,
        state: {},
        params: {},
        schedule: {
          interval: '1h',
        },
      })
      .then(() => {
        this.dependencies.logger.debug('Scheduled queue task');
        return this.dependencies.taskManagerStart.runSoon(INDEX_QUEUED_DOCUMENTS_TASK_ID);
      })
      .then(() => {
        this.dependencies.logger.debug('Queue task ran');
      })
      .catch((err) => {
        this.dependencies.logger.error(`Failed to schedule queue task`);
        this.dependencies.logger.error(err);
      });
  }

  private async processOperation(operation: KnowledgeBaseEntryOperation) {
    if (operation.type === KnowledgeBaseEntryOperationType.Delete) {
      await this.dependencies.esClient.asInternalUser.deleteByQuery({
        index: resourceNames.aliases.kb,
        query: {
          bool: {
            filter: [
              ...(operation.doc_id ? [{ term: { _id: operation.doc_id } }] : []),
              ...(operation.labels
                ? map(operation.labels, (value, key) => {
                    return { term: { [key]: value } };
                  })
                : []),
            ],
          },
        },
      });
      return;
    }

    await this.addEntry({
      entry: operation.document,
    });
  }

  async processQueue() {
    if (!this._queue.length || !this.dependencies.enabled) {
      return;
    }

    if (!(await this.status()).ready) {
      this.dependencies.logger.debug(`Bailing on queue task: KB is not ready yet`);
      return;
    }

    this.dependencies.logger.debug(`Processing queue`);

    this.hasSetup = true;

    this.dependencies.logger.info(`Processing ${this._queue.length} queue operations`);

    const limiter = pLimit(5);

    const operations = this._queue.concat();

    await Promise.all(
      operations.map((operation) =>
        limiter(async () => {
          this._queue.splice(operations.indexOf(operation), 1);
          await this.processOperation(operation);
        })
      )
    );

    this.dependencies.logger.info('Processed all queued operations');
  }

  queue(operations: KnowledgeBaseEntryOperation[]): void {
    if (!operations.length) {
      return;
    }

    if (!this.hasSetup) {
      this._queue.push(...operations);
      return;
    }

    const limiter = pLimit(5);

    const limitedFunctions = this._queue.map((operation) =>
      limiter(() => this.processOperation(operation))
    );

    Promise.all(limitedFunctions).catch((err) => {
      this.dependencies.logger.error(`Failed to process all queued operations`);
      this.dependencies.logger.error(err);
    });
  }

  status = async () => {
    if (!this.dependencies.enabled) {
      return { ready: false, enabled: false };
    }
    const elserModelId = await this.dependencies.getModelId();

    try {
      const modelStats = await this.dependencies.esClient.asInternalUser.ml.getTrainedModelsStats({
        model_id: elserModelId,
      });
      const elserModelStats = modelStats.trained_model_stats[0];
      const deploymentState = elserModelStats.deployment_stats?.state;
      const allocationState = elserModelStats.deployment_stats?.allocation_status.state;

      return {
        ready: deploymentState === 'started' && allocationState === 'fully_allocated',
        deployment_state: deploymentState,
        allocation_state: allocationState,
        model_name: elserModelId,
        enabled: true,
      };
    } catch (error) {
      return {
        error: error instanceof errors.ResponseError ? error.body.error : String(error),
        ready: false,
        enabled: true,
        model_name: elserModelId,
      };
    }
  };

  private async recallFromKnowledgeBase({
    queries,
    categories,
    namespace,
    user,
    modelId,
  }: {
    queries: Array<{ text: string; boost?: number }>;
    categories?: string[];
    namespace: string;
    user?: { name: string };
    modelId: string;
  }): Promise<RecalledEntry[]> {
    const esQuery = {
      bool: {
        should: queries.map(({ text, boost = 1 }) => ({
          text_expansion: {
            'ml.tokens': {
              model_text: text,
              model_id: modelId,
              boost,
            },
          },
        })),
        filter: [
          ...getAccessQuery({
            user,
            namespace,
          }),
          ...getCategoryQuery({ categories }),

          // exclude user instructions
          { bool: { must_not: { term: { type: KnowledgeBaseType.UserInstruction } } } },
        ],
      },
    };

    const response = await this.dependencies.esClient.asInternalUser.search<
      Pick<KnowledgeBaseEntry, 'text' | 'is_correction' | 'labels'>
    >({
      index: [resourceNames.aliases.kb],
      query: esQuery,
      size: 20,
      _source: {
        includes: ['text', 'is_correction', 'labels'],
      },
    });

    return response.hits.hits.map((hit) => ({
      ...hit._source!,
      score: hit._score!,
      id: hit._id!,
    }));
  }

  recall = async ({
    user,
    queries,
    categories,
    namespace,
    esClient,
    uiSettingsClient,
  }: {
    queries: Array<{ text: string; boost?: number }>;
    categories?: string[];
    user?: { name: string };
    namespace: string;
    esClient: { asCurrentUser: ElasticsearchClient; asInternalUser: ElasticsearchClient };
    uiSettingsClient: IUiSettingsClient;
  }): Promise<{
    entries: RecalledEntry[];
  }> => {
    if (!this.dependencies.enabled) {
      return { entries: [] };
    }
    this.dependencies.logger.debug(
      () => `Recalling entries from KB for queries: "${JSON.stringify(queries)}"`
    );
    const modelId = await this.dependencies.getModelId();

    const [documentsFromKb, documentsFromConnectors] = await Promise.all([
      this.recallFromKnowledgeBase({
        user,
        queries,
        categories,
        namespace,
        modelId,
      }).catch((error) => {
        if (isModelMissingOrUnavailableError(error)) {
          throwKnowledgeBaseNotReady(error.body);
        }
        throw error;
      }),
      recallFromConnectors({
        esClient,
        uiSettingsClient,
        queries,
        modelId,
        logger: this.dependencies.logger,
      }).catch((error) => {
        this.dependencies.logger.debug('Error getting data from search indices');
        this.dependencies.logger.debug(error);
        return [];
      }),
    ]);

    this.dependencies.logger.debug(
      `documentsFromKb: ${JSON.stringify(documentsFromKb.slice(0, 5), null, 2)}`
    );
    this.dependencies.logger.debug(
      `documentsFromConnectors: ${JSON.stringify(documentsFromConnectors.slice(0, 5), null, 2)}`
    );

    const sortedEntries = orderBy(
      documentsFromKb.concat(documentsFromConnectors),
      'score',
      'desc'
    ).slice(0, 20);

    const MAX_TOKENS = 4000;

    let tokenCount = 0;

    const returnedEntries: RecalledEntry[] = [];

    for (const entry of sortedEntries) {
      returnedEntries.push(entry);
      tokenCount += encode(entry.text).length;
      if (tokenCount >= MAX_TOKENS) {
        break;
      }
    }

    const droppedEntries = sortedEntries.length - returnedEntries.length;
    if (droppedEntries > 0) {
      this.dependencies.logger.info(`Dropped ${droppedEntries} entries because of token limit`);
    }

    return {
      entries: returnedEntries,
    };
  };

  getUserInstructions = async (
    namespace: string,
    user?: { name: string }
  ): Promise<Array<Instruction & { public?: boolean }>> => {
    if (!this.dependencies.enabled) {
      return [];
    }
    try {
      const response = await this.dependencies.esClient.asInternalUser.search<KnowledgeBaseEntry>({
        index: resourceNames.aliases.kb,
        query: {
          bool: {
            filter: [
              {
                term: {
                  type: KnowledgeBaseType.UserInstruction,
                },
              },
              ...getAccessQuery({ user, namespace }),
            ],
          },
        },
        size: 500,
        _source: ['doc_id', 'text', 'public'],
      });

      return response.hits.hits.map((hit) => ({
        doc_id: hit._source?.doc_id ?? '',
        text: hit._source?.text ?? '',
        public: hit._source?.public,
      }));
    } catch (error) {
      this.dependencies.logger.error('Failed to load instructions from knowledge base');
      this.dependencies.logger.error(error);
      return [];
    }
  };

  getEntries = async ({
    query,
    sortBy,
    sortDirection,
  }: {
    query?: string;
    sortBy?: string;
    sortDirection?: 'asc' | 'desc';
  }): Promise<{ entries: KnowledgeBaseEntry[] }> => {
    if (!this.dependencies.enabled) {
      return { entries: [] };
    }
    try {
      const response = await this.dependencies.esClient.asInternalUser.search<KnowledgeBaseEntry>({
        index: resourceNames.aliases.kb,
        query: {
          bool: {
            filter: [
              // filter title by query
              ...(query ? [{ wildcard: { doc_id: { value: `${query}*` } } }] : []),
              {
                // exclude user instructions
                bool: { must_not: { term: { type: KnowledgeBaseType.UserInstruction } } },
              },
            ],
          },
        },
        sort: [
          {
            [String(sortBy)]: {
              order: sortDirection,
            },
          },
        ],
        size: 500,
        _source: {
          includes: [
            'doc_id',
            'text',
            'is_correction',
            'labels',
            'confidence',
            'public',
            '@timestamp',
            'role',
            'user.name',
            'type',
          ],
        },
      });

      return {
        entries: response.hits.hits.map((hit) => ({
          ...hit._source!,
          role: hit._source!.role ?? KnowledgeBaseEntryRole.UserEntry,
          score: hit._score,
          id: hit._id!,
        })),
      };
    } catch (error) {
      if (isModelMissingOrUnavailableError(error)) {
        throwKnowledgeBaseNotReady(error.body);
      }
      throw error;
    }
  };

  getExistingUserInstructionId = async ({
    isPublic,
    user,
    namespace,
  }: {
    isPublic: boolean;
    user?: { name: string; id?: string };
    namespace?: string;
  }) => {
    if (!this.dependencies.enabled) {
      return null;
    }
    const res = await this.dependencies.esClient.asInternalUser.search<
      Pick<KnowledgeBaseEntry, 'doc_id'>
    >({
      index: resourceNames.aliases.kb,
      query: {
        bool: {
          filter: [
            { term: { type: KnowledgeBaseType.UserInstruction } },
            { term: { public: isPublic } },
            ...getAccessQuery({ user, namespace }),
          ],
        },
      },
      size: 1,
      _source: ['doc_id'],
    });

    return res.hits.hits[0]?._source?.doc_id;
  };

  addEntry = async ({
    entry: { id, ...document },
    user,
    namespace,
  }: {
    entry: Omit<KnowledgeBaseEntry, '@timestamp'>;
    user?: { name: string; id?: string };
    namespace?: string;
  }): Promise<void> => {
    if (!this.dependencies.enabled) {
      return;
    }
    // for now we want to limit the number of user instructions to 1 per user
    if (document.type === KnowledgeBaseType.UserInstruction) {
      const existingId = await this.getExistingUserInstructionId({
        isPublic: document.public,
        user,
        namespace,
      });

      if (existingId) {
        id = existingId;
        document.doc_id = existingId;
      }
    }

    try {
      await this.dependencies.esClient.asInternalUser.index({
        index: resourceNames.aliases.kb,
        id,
        document: {
          '@timestamp': new Date().toISOString(),
          ...document,
          user,
          namespace,
        },
        pipeline: resourceNames.pipelines.kb,
        refresh: 'wait_for',
      });
    } catch (error) {
      if (error instanceof errors.ResponseError && error.body.error.type === 'status_exception') {
        throwKnowledgeBaseNotReady(error.body);
      }
      throw error;
    }
  };

  addEntries = async ({
    operations,
  }: {
    operations: KnowledgeBaseEntryOperation[];
  }): Promise<void> => {
    if (!this.dependencies.enabled) {
      return;
    }
    this.dependencies.logger.info(`Starting import of ${operations.length} entries`);

    const limiter = pLimit(5);

    await Promise.all(
      operations.map((operation) =>
        limiter(async () => {
          await this.processOperation(operation);
        })
      )
    );

    this.dependencies.logger.info(`Completed import of ${operations.length} entries`);
  };

  deleteEntry = async ({ id }: { id: string }): Promise<void> => {
    try {
      await this.dependencies.esClient.asInternalUser.delete({
        index: resourceNames.aliases.kb,
        id,
        refresh: 'wait_for',
      });

      return Promise.resolve();
    } catch (error) {
      if (isModelMissingOrUnavailableError(error)) {
        throwKnowledgeBaseNotReady(error.body);
      }
      throw error;
    }
  };
}

/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { z } from 'zod';

/*
 * NOTICE: Do not edit this file manually.
 * This file is automatically generated by the OpenAPI Generator, @kbn/openapi-generator.
 */

import {
  SavedQueryId,
  DescriptionOrUndefined,
  QueryOrUndefined,
  ECSMappingOrUndefined,
  VersionOrUndefined,
  Interval,
  SnapshotOrUndefined,
  RemovedOrUndefined,
} from '../model/schema/common_attributes.gen';

export type CreateSavedQueryRequestBody = z.infer<typeof CreateSavedQueryRequestBody>;
export const CreateSavedQueryRequestBody = z.object({
  id: SavedQueryId.optional(),
  description: DescriptionOrUndefined.optional(),
  query: QueryOrUndefined.optional(),
  ecs_mapping: ECSMappingOrUndefined.optional(),
  version: VersionOrUndefined.optional(),
  platform: DescriptionOrUndefined.optional(),
  interval: Interval.optional(),
  snapshot: SnapshotOrUndefined.optional(),
  removed: RemovedOrUndefined.optional(),
});

export type SuccessResponse = z.infer<typeof SuccessResponse>;
export const SuccessResponse = z.object({});

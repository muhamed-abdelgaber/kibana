/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  EuiPageSection,
  EuiSpacer,
  EuiButton,
  EuiPageTemplate,
  EuiFlexItem,
  EuiFlexGroup,
  EuiPopover,
  EuiButtonIcon,
  EuiContextMenuItem,
  EuiContextMenuPanel,
  EuiText,
  EuiIcon,
  EuiButtonEmpty,
} from '@elastic/eui';
import React, { useCallback, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { FormattedMessage } from '@kbn/i18n-react';
import { i18n } from '@kbn/i18n';
import { SectionLoading } from '@kbn/es-ui-shared-plugin/public';
import { useIndex } from '../../hooks/api/use_index';
import { useKibana } from '../../hooks/use_kibana';
import { DeleteIndexModal } from './delete_index_modal';

export const SearchIndexDetailsPage = () => {
  const indexName = decodeURIComponent(useParams<{ indexName: string }>().indexName);
  const { console: consolePlugin, docLinks, application } = useKibana().services;
  const { data: index, refetch, isLoading, isSuccess } = useIndex(indexName);
  const embeddableConsole = useMemo(
    () => (consolePlugin?.EmbeddableConsole ? <consolePlugin.EmbeddableConsole /> : null),
    [consolePlugin]
  );
  const navigateToIndexListPage = useCallback(() => {
    application.navigateToApp('management', { deepLinkId: 'index_management' });
  }, [application]);

  const [showMoreOptions, setShowMoreOptions] = useState<boolean>(false);
  const [isShowingDeleteModal, setShowDeleteIndexModal] = useState<boolean>(false);
  const moreOptionsPopover = (
    <EuiPopover
      isOpen={showMoreOptions}
      closePopover={() => setShowMoreOptions(!showMoreOptions)}
      button={
        <EuiButtonIcon
          iconType="boxesVertical"
          onClick={() => setShowMoreOptions(!showMoreOptions)}
          size="m"
          data-test-subj="moreOptionsActionButton"
          aria-label={i18n.translate('xpack.searchIndices.moreOptions.ariaLabel', {
            defaultMessage: 'More options',
          })}
        />
      }
    >
      <EuiContextMenuPanel
        data-test-subj="moreOptionsContextMenu"
        items={[
          <EuiContextMenuItem
            key="trash"
            icon={<EuiIcon type="trash" color="danger" />}
            onClick={() => {
              setShowDeleteIndexModal(!isShowingDeleteModal);
            }}
            size="s"
            color="danger"
            data-test-subj="moreOptionsDeleteIndex"
          >
            <EuiText size="s" color="danger">
              {i18n.translate('xpack.searchIndices.moreOptions.deleteIndexLabel', {
                defaultMessage: 'Delete Index',
              })}
            </EuiText>
          </EuiContextMenuItem>,
        ]}
      />
    </EuiPopover>
  );

  if (isLoading && !index) {
    return (
      <SectionLoading>
        {i18n.translate('xpack.searchIndices.loadingDescription', {
          defaultMessage: 'Loading index details…',
        })}
      </SectionLoading>
    );
  }
  const pageloadingError = (
    <EuiPageTemplate.EmptyPrompt
      data-test-subj="pageLoadError"
      color="danger"
      iconType="warning"
      title={
        <h2>
          <FormattedMessage
            id="xpack.searchIndices.pageLoaError.errorTitle"
            defaultMessage="Unable to load index details"
          />
        </h2>
      }
      body={
        <EuiText color="subdued">
          <FormattedMessage
            id="xpack.searchIndices.pageLoadError.description"
            defaultMessage="We encountered an error loading data for index {indexName}. Make sure that the index name in the URL is correct and try again."
            values={{
              indexName,
            }}
          />
        </EuiText>
      }
      actions={
        <EuiFlexGroup justifyContent="spaceAround">
          <EuiFlexItem grow={false}>
            <EuiButtonEmpty
              color="danger"
              iconType="arrowLeft"
              onClick={() => navigateToIndexListPage()}
              data-test-subj="loadingErrorBackToIndicesButton"
            >
              <FormattedMessage
                id="xpack.searchIndices.pageLoadError.backToIndicesButtonLabel"
                defaultMessage="Back to indices"
              />
            </EuiButtonEmpty>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiButton
              iconSide="right"
              onClick={() => refetch}
              iconType="refresh"
              color="danger"
              data-test-subj="reloadButton"
            >
              <FormattedMessage
                id="xpack.searchIndices.pageLoadError.reloadButtonLabel"
                defaultMessage="Reload"
              />
            </EuiButton>
          </EuiFlexItem>
        </EuiFlexGroup>
      }
    />
  );

  return (
    <EuiPageTemplate
      offset={0}
      restrictWidth={false}
      data-test-subj="searchIndicesDetailsPage"
      grow={false}
      bottomBorder={false}
    >
      {!isSuccess || !index ? (
        pageloadingError
      ) : (
        <>
          <EuiPageSection>
            <EuiButton
              data-test-subj="backToIndicesButton"
              color="text"
              iconType="arrowLeft"
              onClick={() => navigateToIndexListPage()}
            >
              <FormattedMessage
                id="xpack.searchIndices.backToIndicesButtonLabel"
                defaultMessage="Back to indices"
              />
            </EuiButton>
          </EuiPageSection>
          <EuiPageTemplate.Header
            data-test-subj="searchIndexDetailsHeader"
            pageTitle={index?.name}
            rightSideItems={[
              <EuiFlexGroup>
                <EuiFlexItem>
                  <EuiButtonEmpty
                    href={docLinks.links.apiReference}
                    target="_blank"
                    iconType="documentation"
                    data-test-subj="ApiReferenceDoc"
                  >
                    {i18n.translate('xpack.searchIndices.indexActionsMenu.apiReference.docLink', {
                      defaultMessage: 'API Reference',
                    })}
                  </EuiButtonEmpty>
                </EuiFlexItem>
                <EuiFlexItem>{moreOptionsPopover}</EuiFlexItem>
              </EuiFlexGroup>,
            ]}
          />
          <EuiSpacer size="l" />

          {isShowingDeleteModal && (
            <DeleteIndexModal
              onCancel={() => setShowDeleteIndexModal(!isShowingDeleteModal)}
              indexName={indexName}
              navigateToIndexListPage={navigateToIndexListPage}
            />
          )}

          <div data-test-subj="searchIndexDetailsContent" />
        </>
      )}
      {embeddableConsole}
    </EuiPageTemplate>
  );
};

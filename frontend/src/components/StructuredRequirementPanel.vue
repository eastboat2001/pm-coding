<script setup lang="ts">
import { computed } from 'vue'

import { structuredRequirementPanelCopy } from './structuredRequirementCopy'
import { computeStructuredRequirementProgress } from '../lib/structuredRequirementProgress'
import type { LanguageCode } from '../types/session'
import type {
  RequirementCollectionItem,
  RequirementCollectionStatus,
  StructuredRequirementFeature,
  StructuredRequirementModel,
  StructuredRequirementPage,
} from '../types/structuredRequirement'

const props = withDefaults(
  defineProps<{
    language: LanguageCode
    model: StructuredRequirementModel
    loading?: boolean
    syncing?: boolean
    generatingPrd?: boolean
    generationDisabled?: boolean
    error?: string
  }>(),
  {
    loading: false,
    syncing: false,
    generatingPrd: false,
    generationDisabled: false,
    error: '',
  },
)
const emit = defineEmits<{
  (event: 'generate-prd'): void
}>()

type RequirementRow = {
  key: string
  label: string
  value: string
  status: RequirementCollectionStatus
  reason: string
  pendingQuestion: string
}

const copy = computed(
  () => structuredRequirementPanelCopy[props.language] ?? structuredRequirementPanelCopy.en,
)

const requirementRows = computed<RequirementRow[]>(() => {
  const model = props.model
  const status = model.collection_status

  return [
    buildRow(
      'objective',
      copy.value.rows.objective,
      summarizeText(model.background.objective),
      status.objective,
    ),
    buildRow(
      'scope',
      copy.value.rows.scope,
      summarizeScope(model.scope.in_scope, model.scope.out_of_scope),
      status.scope,
    ),
    buildRow(
      'users',
      copy.value.rows.users,
      summarizeList(model.users_and_scenarios.target_users),
      status.users,
    ),
    buildRow(
      'scenarios',
      copy.value.rows.scenarios,
      summarizeList(model.users_and_scenarios.core_scenarios),
      status.scenarios,
    ),
    buildRow(
      'features',
      copy.value.rows.features,
      summarizeFeatures(model.functional_requirements.overview, model.functional_requirements.feature_details),
      status.features,
    ),
    buildRow(
      'pages',
      copy.value.rows.pages,
      summarizePages(model.page_and_interaction.pages),
      status.pages,
    ),
    buildRow(
      'rules',
      copy.value.rows.rules,
      summarizeList(model.business_rules),
      status.rules,
    ),
    buildRow(
      'integrations',
      copy.value.rows.integrations,
      summarizeList(model.data_and_dependencies),
      status.integrations,
    ),
    buildRow(
      'acceptance',
      copy.value.rows.acceptance,
      summarizeList(model.acceptance_criteria),
      status.acceptance,
    ),
  ].sort((left, right) => statusPriority(left.status) - statusPriority(right.status))
})

const progress = computed(() => computeStructuredRequirementProgress(props.model))

const progressStyle = computed(() => {
  const progressValue = progress.value.collectionCoveragePercentage * 3.6
  return {
    background: `conic-gradient(var(--accent) 0deg ${progressValue}deg, #e7ece9 ${progressValue}deg 360deg)`,
  }
})

function buildRow(
  key: string,
  label: string,
  rawValue: string,
  collectionItem: RequirementCollectionItem,
): RequirementRow {
  const value = rawValue.trim()
  return {
    key,
    label,
    value: value || copy.value.notCaptured,
    status: collectionItem.status,
    reason: collectionItem.reason.trim(),
    pendingQuestion: collectionItem.pending_questions[0]?.trim() || '',
  }
}

function statusPriority(status: RequirementCollectionStatus): number {
  if (status === 'conflict') {
    return 0
  }
  if (status === 'pending_confirmation') {
    return 1
  }
  if (status === 'missing') {
    return 2
  }
  if (status === 'captured') {
    return 3
  }
  return 4
}

function statusLabel(status: RequirementCollectionStatus): string {
  if (status === 'confirmed') {
    return copy.value.status.confirmed
  }
  if (status === 'pending_confirmation') {
    return copy.value.status.pendingConfirmation
  }
  if (status === 'captured') {
    return copy.value.status.captured
  }
  if (status === 'conflict') {
    return copy.value.status.conflict
  }
  return copy.value.status.missing
}

function statusClass(status: RequirementCollectionStatus): string {
  if (status === 'pending_confirmation') {
    return 'pending'
  }
  return status
}

function summarizeScope(inScope: string[], outOfScope: string[]): string {
  const include = summarizeList(inScope, 2)
  const exclude = summarizeList(outOfScope, 2)
  if (include && exclude) {
    return `${copy.value.scopeLabels.in}: ${include} / ${copy.value.scopeLabels.out}: ${exclude}`
  }
  if (include) {
    return `${copy.value.scopeLabels.in}: ${include}`
  }
  if (exclude) {
    return `${copy.value.scopeLabels.out}: ${exclude}`
  }
  return ''
}

function summarizeFeatures(overview: string, features: StructuredRequirementFeature[]): string {
  const names = features
    .map((item) => item.feature_name || item.description)
    .filter(Boolean)
  const featureSummary = summarizeList(names, 2)
  if (featureSummary) {
    return featureSummary
  }
  return summarizeText(overview)
}

function summarizePages(pages: StructuredRequirementPage[]): string {
  const names = pages.map((item) => item.page_name || item.entry_point).filter(Boolean)
  return summarizeList(names, 2)
}

function summarizeList(values: string[], limit = 2): string {
  const normalized = values.map((item) => item.trim()).filter(Boolean)
  if (!normalized.length) {
    return ''
  }

  const clipped = normalized.slice(0, limit).join(' / ')
  return normalized.length > limit ? `${clipped} ...` : clipped
}

function summarizeText(value: string): string {
  const normalized = value.trim()
  if (!normalized) {
    return ''
  }

  return normalized.length > 96 ? `${normalized.slice(0, 96).trimEnd()} ...` : normalized
}
</script>

<template>
  <aside class="requirement-panel-stack">
    <section class="requirement-card progress-card">
      <header class="card-head compact">
        <div class="card-title">
          <svg class="card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="2" width="6" height="4" rx="1"/>
            <path d="M9 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3"/>
            <path d="M9 12h6"/>
            <path d="M9 16h4"/>
          </svg>
          <h3>{{ copy.progressTitle }}</h3>
        </div>
        <span v-if="syncing" class="sync-badge">{{ copy.syncing }}</span>
      </header>

      <div class="progress-body">
        <div class="progress-visual">
          <div class="progress-ring" :style="progressStyle">
            <div class="progress-ring-inner">
              <span>{{ progress.collectionCoveragePercentage }}%</span>
            </div>
          </div>
          <p class="progress-caption">{{ copy.progressLabels.coverage }}</p>
        </div>

        <div class="progress-meta">
          <div class="progress-row">
            <span>{{ copy.progressLabels.coverage }}</span>
            <strong>{{ progress.collectedCount }}/{{ progress.totalCount }}</strong>
          </div>
          <div class="progress-row">
            <span>{{ copy.progressLabels.confirmationRate }}</span>
            <strong>{{ progress.confirmationPercentage }}%</strong>
          </div>
          <div class="progress-row">
            <span>{{ copy.progressLabels.pendingConfirmation }}</span>
            <strong>{{ progress.pendingConfirmationCount }}</strong>
          </div>
          <div class="progress-row">
            <span>{{ copy.progressLabels.conflict }}</span>
            <strong>{{ progress.conflictCount }}</strong>
          </div>
        </div>
      </div>

      <div class="progress-actions">
        <button
          class="generate-prd-btn"
          :class="{ ready: progress.readyToGenerate }"
          type="button"
          :disabled="loading || generatingPrd || generationDisabled"
          @click="emit('generate-prd')"
        >
          {{ generatingPrd ? copy.generatingPrd : copy.generatePrd }}
        </button>
      </div>
    </section>

    <section class="requirement-card table-card">
      <header class="card-head">
        <div class="card-title">
          <svg class="card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <path d="M14 2v6h6"/>
            <path d="M16 13H8"/>
            <path d="M16 17H8"/>
            <path d="M10 9H8"/>
          </svg>
          <h3>{{ copy.requirementTitle }}</h3>
        </div>
        <span v-if="syncing" class="sync-badge">{{ copy.syncing }}</span>
      </header>

      <div v-if="loading" class="card-state">
        {{ copy.loading }}
      </div>
      <div v-else-if="error" class="card-state error">
        {{ error }}
      </div>
      <div v-else class="card-list-shell">
        <div class="requirement-list">
          <article
            v-for="row in requirementRows"
            :key="row.key"
            class="requirement-item-card"
            :class="statusClass(row.status)"
          >
            <header class="requirement-item-head">
              <h4>{{ row.label }}</h4>
              <span class="status-pill" :class="statusClass(row.status)">
                {{ statusLabel(row.status) }}
              </span>
            </header>

            <p class="requirement-item-content" :title="row.value">
              {{ row.value }}
            </p>

            <div v-if="row.reason || row.pendingQuestion" class="requirement-item-notes">
              <div v-if="row.reason" class="requirement-note">
                <span class="requirement-note-label">{{ copy.cardLabels.reason }}</span>
                <p>{{ row.reason }}</p>
              </div>
              <div v-if="row.pendingQuestion" class="requirement-note question">
                <span class="requirement-note-label">{{ copy.cardLabels.pendingQuestion }}</span>
                <p>{{ row.pendingQuestion }}</p>
              </div>
            </div>
          </article>
        </div>
      </div>
    </section>
  </aside>
</template>

<style scoped>
.requirement-panel-stack {
  min-height: 0;
  height: 100%;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  align-content: stretch;
  gap: 14px;
  overflow: hidden;
}

.requirement-card {
  border: 1px solid var(--line);
  border-radius: 18px;
  background: #fff;
  box-shadow: 0 10px 24px rgba(13, 35, 28, 0.05);
  overflow: hidden;
}

.table-card {
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.card-head {
  padding: 18px 18px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.card-head.compact {
  padding-bottom: 8px;
}

.card-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.card-title h3 {
  margin: 0;
  font-size: 0.98rem;
}

.sync-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 999px;
  background: #eef7f3;
  color: #2d6a59;
  font-size: 0.76rem;
  font-weight: 700;
  white-space: nowrap;
}

.sync-badge::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  animation: syncPulse 1.2s ease-in-out infinite;
}

.card-icon {
  width: 22px;
  height: 22px;
  color: #334641;
  flex-shrink: 0;
}

.card-state {
  margin: 0 18px 18px;
  padding: 14px;
  border-radius: 14px;
  border: 1px dashed #c8d7d1;
  color: var(--muted);
  background: #fbfdfc;
  line-height: 1.5;
}

.card-state.error {
  border-style: solid;
  border-color: #efb7b7;
  color: #8b2525;
  background: #fff4f4;
}

.progress-body {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 16px;
  padding: 0 18px 18px;
}

.progress-visual {
  display: grid;
  justify-items: center;
  gap: 10px;
}

.progress-ring {
  width: 108px;
  height: 108px;
  border-radius: 50%;
  display: grid;
  place-items: center;
}

.progress-ring-inner {
  width: 74px;
  height: 74px;
  border-radius: 50%;
  background: #fff;
  display: grid;
  place-items: center;
  box-shadow: inset 0 0 0 1px #edf2ef;
}

.progress-ring-inner span {
  font-size: 1.38rem;
  font-weight: 800;
  letter-spacing: -0.04em;
  color: #182622;
}

.progress-caption {
  margin: 0;
  color: #51625d;
  font-size: 0.82rem;
  font-weight: 700;
}

.progress-meta {
  display: grid;
  gap: 10px;
}

.progress-actions {
  padding: 0 18px 18px;
}

.generate-prd-btn {
  width: 100%;
  border: 1px solid #d3e1db;
  border-radius: 14px;
  padding: 12px 16px;
  background: #f6faf8;
  color: #17312b;
  font-weight: 700;
  cursor: pointer;
  transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease, background 0.2s ease, color 0.2s ease;
}

.generate-prd-btn:hover:not(:disabled) {
  transform: translateY(-1px);
  border-color: #bfd4ca;
  box-shadow: 0 10px 18px rgba(13, 35, 28, 0.08);
}

.generate-prd-btn.ready {
  background: linear-gradient(135deg, #0e7c66 0%, #1f9a82 100%);
  border-color: #0e7c66;
  color: #fff;
  box-shadow: 0 14px 22px rgba(14, 124, 102, 0.2);
}

.generate-prd-btn:disabled {
  opacity: 0.72;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}

.progress-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  color: #334641;
  font-size: 0.94rem;
}

.progress-row strong {
  color: #172422;
  font-size: 1rem;
}

.card-list-shell {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 0 4px 14px 0;
  scrollbar-width: none;
  scrollbar-color: transparent transparent;
  scrollbar-gutter: stable;
}

.card-list-shell::-webkit-scrollbar {
  width: 0;
}

.card-list-shell::-webkit-scrollbar-track {
  background: transparent;
}

.card-list-shell::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: 999px;
}

.workspace-side:hover .card-list-shell,
.table-card:hover .card-list-shell {
  scrollbar-width: thin;
  scrollbar-color: rgba(109, 137, 128, 0.82) transparent;
}

.workspace-side:hover .card-list-shell::-webkit-scrollbar,
.table-card:hover .card-list-shell::-webkit-scrollbar {
  width: 6px;
}

.workspace-side:hover .card-list-shell::-webkit-scrollbar-track,
.table-card:hover .card-list-shell::-webkit-scrollbar-track {
  background: transparent;
}

.workspace-side:hover .card-list-shell::-webkit-scrollbar-thumb,
.table-card:hover .card-list-shell::-webkit-scrollbar-thumb {
  background: rgba(109, 137, 128, 0.82);
  border-radius: 999px;
}

.workspace-side:hover .card-list-shell::-webkit-scrollbar-thumb:hover,
.table-card:hover .card-list-shell::-webkit-scrollbar-thumb:hover {
  background: rgba(76, 104, 96, 0.92);
}

.requirement-list {
  display: grid;
  gap: 12px;
}

.requirement-item-card {
  padding: 14px;
  border: 1px solid #e7efea;
  border-radius: 16px;
  background: linear-gradient(180deg, #ffffff 0%, #fafcfb 100%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.65);
}

.requirement-item-card.missing {
  background: linear-gradient(180deg, #ffffff 0%, #f6f8f7 100%);
}

.requirement-item-card.captured {
  border-color: #d8e9e2;
  background: linear-gradient(180deg, #ffffff 0%, #f7fcf9 100%);
}

.requirement-item-card.pending {
  border-color: #eadfb9;
  background: linear-gradient(180deg, #fffef9 0%, #fcf8eb 100%);
}

.requirement-item-card.confirmed {
  border-color: #cae5d9;
  background: linear-gradient(180deg, #fbfffd 0%, #eef8f3 100%);
}

.requirement-item-card.conflict {
  border-color: #efc7c7;
  background: linear-gradient(180deg, #fffdfd 0%, #fff3f3 100%);
}

.requirement-item-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.requirement-item-head h4 {
  margin: 0;
  font-size: 0.98rem;
  line-height: 1.35;
  color: #10231f;
}

.requirement-item-content {
  margin: 12px 0 0;
  color: #30423d;
  line-height: 1.65;
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.requirement-item-notes {
  display: grid;
  gap: 10px;
  margin-top: 12px;
}

.requirement-note {
  padding: 10px 12px;
  border-radius: 12px;
  background: rgba(241, 246, 243, 0.9);
  border: 1px solid #e0ebe5;
}

.requirement-note.question {
  background: rgba(250, 246, 232, 0.9);
  border-color: #eadfb9;
}

.requirement-note-label {
  display: inline-block;
  margin-bottom: 6px;
  color: #51625d;
  font-size: 0.76rem;
  font-weight: 700;
}

.requirement-note p {
  margin: 0;
  color: #30423d;
  line-height: 1.55;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 68px;
  padding: 6px 10px;
  border-radius: 999px;
  font-size: 0.76rem;
  font-weight: 700;
  white-space: nowrap;
  flex-shrink: 0;
}

.status-pill.missing {
  background: #f1f4f2;
  color: #5d6d67;
}

.status-pill.captured {
  background: #edf7f2;
  color: #2c6a59;
}

.status-pill.pending {
  background: #f8f0d8;
  color: #8b6414;
}

.status-pill.confirmed {
  background: #e8f5ee;
  color: #0b5c4a;
}

.status-pill.conflict {
  background: #fde7e7;
  color: #922f2f;
}

@media (max-width: 1200px) {
  .progress-body {
    grid-template-columns: 1fr;
    justify-items: center;
  }

  .progress-meta {
    width: 100%;
  }
}

@media (max-width: 768px) {
  .requirement-panel-stack {
    height: min(88vh, 820px);
    overflow: hidden;
  }
}

@keyframes syncPulse {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.8);
  }
  50% {
    opacity: 1;
    transform: scale(1);
  }
}
</style>

import { formatBytes, translate } from "../core/context";

// Each severity has a label and an icon, so it never depends on colour alone.
const SEVERITY_ICON = {
  critical: "PhWarningOctagon",
  high: "PhWarning",
  medium: "PhWarningCircle",
  low: "PhInfo",
  info: "PhInfo",
  none: "PhShieldCheck",
};

// The body of a skill_install approval card: the overall assessment and audit coverage first,
// then the skill and its review, then findings by severity with expandable evidence, then notes.
// The user decides here rather than from the agent's summary.
const ChatSkillInstallPreview = {
  props: {
    // skillInstallApproval(...) from core/chat-approvals.
    preview: { type: Object, required: true },
  },
  setup() {
    const t = translate;
    const severityLabel = (severity) => t(`chat_skill_severity_${severity}`);
    const findingPlace = (finding) => (finding.line ? `${finding.file}:${finding.line}` : finding.file);
    return { t, formatBytes, severityLabel, severityIcon: (s) => SEVERITY_ICON[s] || "PhInfo", findingPlace };
  },
  template: `
    <div class="chat-skill-preview">
      <div v-if="preview.expired" class="chat-approval-error" role="alert">
        <PhInfo class="icon" aria-hidden="true" />
        <span>{{ t('chat_skill_preview_expired') }}</span>
      </div>
      <template v-else>
        <div v-if="preview.mismatch" class="chat-approval-error" role="alert">
          <PhInfo class="icon" aria-hidden="true" />
          <span>{{ t('chat_skill_preview_mismatch') }}</span>
        </div>

        <!-- 1. Overall assessment and coverage. -->
        <section
          class="chat-skill-assessment"
          :class="preview.assessment.complete ? 'is-level-' + preview.assessment.level : 'is-incomplete'"
          :aria-label="t('chat_skill_assessment')"
        >
          <div class="chat-skill-assessment-head">
            <component
              :is="preview.assessment.complete ? severityIcon(preview.assessment.level) : 'PhQuestion'"
              class="chat-skill-assessment-icon"
              aria-hidden="true"
            />
            <div class="chat-skill-assessment-copy">
              <strong class="chat-skill-assessment-title">
                {{ preview.assessment.complete ? t('chat_skill_level_' + preview.assessment.level) : t('chat_skill_not_fully_assessed') }}
              </strong>
              <span class="chat-skill-assessment-score">
                {{ preview.assessment.complete
                  ? t('chat_skill_score', { score: preview.assessment.score })
                  : t('chat_skill_score_so_far', { level: severityLabel(preview.assessment.level), score: preview.assessment.score }) }}
              </span>
            </div>
          </div>
          <ul v-if="!preview.assessment.complete && preview.assessment.incompleteReasons.length" class="chat-skill-assessment-reasons">
            <li v-for="(reason, index) in preview.assessment.incompleteReasons" :key="'why:' + index">{{ reason }}</li>
          </ul>
          <p class="chat-skill-coverage">
            {{ t('chat_skill_coverage', { files: preview.coverage.files, reviewed: preview.coverage.reviewed, inspected: preview.coverage.inspected }) }}
            <template v-if="preview.coverage.gaps.length"> · <strong>{{ t('chat_skill_coverage_gaps', { count: preview.coverage.gaps.length }) }}</strong></template>
          </p>
          <details v-if="preview.coverage.gaps.length" class="chat-skill-details">
            <summary>{{ t('chat_skill_coverage_gaps_show') }}</summary>
            <ul class="chat-skill-gap-list">
              <li v-for="gap in preview.coverage.gaps" :key="gap.path">
                <code>{{ gap.path }}</code>
                <span class="chat-skill-gap-status">{{ t('chat_skill_audit_' + gap.status) }}</span>
                <span v-if="gap.note" class="chat-skill-gap-note">{{ gap.note }}</span>
              </li>
            </ul>
          </details>
          <details v-if="preview.assessment.rubric" class="chat-skill-details">
            <summary>{{ t('chat_skill_rubric') }}</summary>
            <p class="chat-skill-rubric">{{ preview.assessment.rubric }}</p>
          </details>
        </section>

        <!-- 2. A failed review stays prominent. -->
        <div v-if="preview.reviewError" class="chat-approval-error" role="alert">
          <PhXCircle class="icon" aria-hidden="true" />
          <span>{{ t('chat_skill_preview_review_failed', { error: preview.reviewError }) }}</span>
        </div>

        <!-- 3. The skill. -->
        <div class="chat-skill-preview-head">
          <strong class="chat-skill-preview-name">{{ preview.name }}</strong>
          <p v-if="preview.description" class="chat-skill-preview-description">{{ preview.description }}</p>
        </div>
        <dl class="chat-approval-params">
          <div class="chat-approval-param">
            <dt><code>{{ t('chat_skill_preview_source') }}</code></dt>
            <dd>
              <a :href="preview.sourceURL" target="_blank" rel="noopener noreferrer" class="chat-skill-preview-link">{{ preview.sourceURL }}</a>
              <code v-if="preview.commit" class="chat-skill-preview-commit">@{{ preview.commit }}</code>
            </dd>
          </div>
          <div class="chat-approval-param">
            <dt><code>{{ t('chat_skill_preview_files') }}</code></dt>
            <dd>{{ t(preview.fileCount === 1 ? 'skills_files_summary_one' : 'skills_files_summary', { count: preview.fileCount, size: formatBytes(preview.totalBytes) }) }}</dd>
          </div>
          <div v-if="preview.requirements.length" class="chat-approval-param">
            <dt><code>{{ t('chat_skill_preview_requires') }}</code></dt>
            <dd>{{ preview.requirements.join(', ') }}</dd>
          </div>
          <div v-if="preview.authProfiles.length" class="chat-approval-param">
            <dt><code>{{ t('chat_skill_preview_auth') }}</code></dt>
            <dd>{{ preview.authProfiles.join(', ') }}</dd>
          </div>
          <div v-if="preview.replaces" class="chat-approval-param">
            <dt><code>{{ t('chat_skill_preview_replaces') }}</code></dt>
            <dd>{{ preview.replace ? t('chat_skill_preview_replaces_yes', { dir: preview.replaces }) : t('chat_skill_preview_replaces_no', { dir: preview.replaces }) }}</dd>
          </div>
        </dl>
        <section v-if="preview.summary || preview.capabilities.length" class="chat-skill-preview-section">
          <h4 class="chat-skill-preview-label">{{ t('chat_skill_preview_review') }}</h4>
          <p v-if="preview.summary" class="chat-skill-preview-text">{{ preview.summary }}</p>
          <ul v-if="preview.capabilities.length" class="chat-skill-preview-list">
            <li v-for="(item, index) in preview.capabilities" :key="'cap:' + index">{{ item }}</li>
          </ul>
        </section>

        <!-- 4. Findings, most severe first, evidence on demand. -->
        <section class="chat-skill-preview-section">
          <h4 class="chat-skill-preview-label">{{ t('chat_skill_findings', { count: preview.issues.length }) }}</h4>
          <p v-if="!preview.issues.length" class="chat-skill-preview-text">{{ t('chat_skill_no_issues') }}</p>
          <ul v-else class="chat-skill-findings">
            <li v-for="finding in preview.issues" :key="finding.id" class="chat-skill-finding" :class="'is-' + finding.severity">
              <details>
                <summary>
                  <span class="chat-skill-severity" :class="'is-' + finding.severity">
                    <component :is="severityIcon(finding.severity)" class="icon" aria-hidden="true" />
                    {{ severityLabel(finding.severity) }}
                  </span>
                  <span class="chat-skill-finding-title">{{ finding.title }}</span>
                  <code v-if="finding.file" class="chat-skill-finding-file">{{ findingPlace(finding) }}</code>
                </summary>
                <div class="chat-skill-finding-body">
                  <pre v-if="finding.evidence" class="chat-skill-evidence"><code>{{ finding.evidence }}</code></pre>
                  <p v-if="finding.rationale" class="chat-skill-preview-text">{{ finding.rationale }}</p>
                  <p class="chat-skill-finding-source">
                    {{ finding.source === 'review' ? t('chat_skill_source_review') : t('chat_skill_source_check') }}
                    <template v-if="finding.evidenceVerified === false"> · {{ t('chat_skill_evidence_unverified') }}</template>
                  </p>
                </div>
              </details>
            </li>
          </ul>
        </section>

        <!-- 5. Informational notes, not risks. -->
        <details v-if="preview.notes.length" class="chat-skill-details chat-skill-notes">
          <summary>{{ t('chat_skill_notes', { count: preview.notes.length }) }}</summary>
          <ul class="chat-skill-note-list">
            <li v-for="note in preview.notes" :key="note.id">
              <span class="chat-skill-severity is-info"><PhInfo class="icon" aria-hidden="true" />{{ severityLabel('info') }}</span>
              <span>{{ note.title }}</span>
              <code v-if="note.file" class="chat-skill-finding-file">{{ findingPlace(note) }}</code>
              <span v-if="note.evidence" class="chat-skill-gap-note">{{ note.evidence }}</span>
            </li>
          </ul>
        </details>

        <p class="chat-skill-preview-note">{{ t('chat_skill_preview_note') }}</p>
      </template>
    </div>
  `,
};

export default ChatSkillInstallPreview;

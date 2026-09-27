import { formatBytes, translate } from "../core/context";

// The body of a skill_install approval card: the preview that approving would install, with
// every risk, so the user decides here rather than from the agent's summary.
const ChatSkillInstallPreview = {
  props: {
    // skillInstallApproval(...) from core/chat-approvals.
    preview: { type: Object, required: true },
  },
  setup() {
    return { t: translate, formatBytes };
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

        <section class="chat-skill-preview-section">
          <h4 class="chat-skill-preview-label">{{ t('chat_skill_preview_review') }}</h4>
          <p v-if="preview.summary" class="chat-skill-preview-text">{{ preview.summary }}</p>
          <p v-if="preview.reviewError" class="chat-skill-preview-warning">{{ t('chat_skill_preview_review_failed', { error: preview.reviewError }) }}</p>
          <ul v-if="preview.capabilities.length" class="chat-skill-preview-list">
            <li v-for="(item, index) in preview.capabilities" :key="'cap:' + index">{{ item }}</li>
          </ul>
        </section>

        <section class="chat-skill-preview-section is-risks">
          <h4 class="chat-skill-preview-label">{{ t('chat_skill_preview_risks', { count: preview.risks.length }) }}</h4>
          <ul v-if="preview.risks.length" class="chat-skill-preview-list">
            <li v-for="(item, index) in preview.risks" :key="'risk:' + index">{{ item }}</li>
          </ul>
          <p v-else class="chat-skill-preview-text">{{ t('chat_skill_preview_no_risks') }}</p>
        </section>

        <p class="chat-skill-preview-note">{{ t('chat_skill_preview_note') }}</p>
      </template>
    </div>
  `,
};

export default ChatSkillInstallPreview;

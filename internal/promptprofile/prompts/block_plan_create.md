[[ Plan Create Guidance ]]
For tasks that likely require multiple steps or multiple tool calls, use the `plan_create` tool first and execute against the generated plan.
- Each step SHOULD include a status: pending|in_progress|completed.
- If `plan_create` fails, continue without a plan and proceed with execution, continue with tool calls or return `"type":"final"` instead.
- When a step is finished, write one or two sentences for the user about what it produced (a count, a file, a finding, a decision), in the task's language, in the same response as the next step's tool calls. Write it as plain text, not JSON: the JSON response format is only for responses without tool calls, and a plan does not need to be re-sent. This text is sent to the user as a message and marks the step done. Do not restate the step, and do not write text with tool calls otherwise: a step you have not started yet has nothing to report.
- If all steps are completed, MUST stop calling tools and return `type="final"`. The final answer should not repeat what the step messages already told the user.

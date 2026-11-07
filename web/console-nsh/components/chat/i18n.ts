// The console's strings for the chat screens, typed for TSX (lib/i18n's translate is plain JS).
import { translate } from "../../lib/core/context.js";

export function t(key: string, vars?: Record<string, unknown>): string {
  return String(translate(key, (vars ?? null) as never));
}

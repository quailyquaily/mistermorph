// The Vue console's strings (lib/i18n), typed for TSX: `t(key, vars)`.
import { translate } from "../../lib/core/context.js";

export const t = translate as unknown as (key: string, vars?: Record<string, unknown>) => string;

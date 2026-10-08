/**
 * Small shared display helpers for console pages.
 */

/**
 * Session IDs are client-supplied verbatim (explicit session header wins) and
 * some clients send a whole JSON blob (e.g. {"device_id":"...","account_uuid":
 * "","session_id":"<uuid>"}). For display, extract the inner session_id when
 * parseable, otherwise truncate over-long ids; full value stays in the tooltip.
 */
export const formatSessionId = (raw: string): string => {
  try {
    const parsed = JSON.parse(raw) as { session_id?: unknown };
    if (parsed && typeof parsed === 'object' && typeof parsed.session_id === 'string' && parsed.session_id) {
      return parsed.session_id;
    }
  } catch {
    /* plain string id */
  }
  return raw.length <= 24 ? raw : `${raw.slice(0, 12)}…${raw.slice(-8)}`;
};

/** Clipboard write with boolean outcome (pages surface success/error toasts). */
export const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

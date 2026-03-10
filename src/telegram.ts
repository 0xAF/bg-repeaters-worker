/**
 * Telegram Bot API integration for guest request notifications.
 * 
 * Sends notifications to multiple configured chat IDs (users, groups, channels)
 * when guest requests are submitted or resolved (approved/rejected).
 * 
 * Environment variables:
 * - BGREPS_TELEGRAM_BOT_TOKEN: Bot token from @BotFather
 * - BGREPS_TELEGRAM_CHAT_IDS: Comma-separated list of chat IDs (e.g., "123456,789012,-1001234567890")
 * - BGREPS_TELEGRAM_NOTIFY_REJECTIONS: "true" to notify on rejections (default: true)
 */

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

type NewRequestNotificationData = {
  requestId: number;
  submitterName: string;
  message?: string;
  hasRepeaterSuggestion: boolean;
  repeaterCallsign?: string;
  country?: string;
};

type ResolvedRequestNotificationData = {
  requestId: number;
  submitterName: string;
  status: 'approved' | 'rejected' | 'archived';
  action?: 'created' | 'updated'; // Only for approved
  repeaterCallsign?: string;
  resolvedBy?: string;
  adminNotes?: string;
};

/**
 * Parse comma-separated chat IDs from environment variable.
 * Validates numeric format (supports positive user IDs, negative group/channel IDs).
 */
function parseChatIds(env: CloudflareBindings): string[] {
  const raw = env.BGREPS_TELEGRAM_CHAT_IDS ?? '';
  if (!raw.trim()) return [];
  
  return raw
    .split(',')
    .map(id => id.trim())
    .filter(id => id.length > 0 && /^-?\d+$/.test(id)); // Validate numeric format
}

/**
 * Check if bot token and chat IDs are configured.
 */
function isConfigured(env: CloudflareBindings): boolean {
  const token = env.BGREPS_TELEGRAM_BOT_TOKEN?.trim();
  const chatIds = parseChatIds(env);
  return !!token && chatIds.length > 0;
}

/**
 * Check if rejection notifications are enabled (default: true).
 */
function shouldNotifyRejections(env: CloudflareBindings): boolean {
  const value = env.BGREPS_TELEGRAM_NOTIFY_REJECTIONS?.toLowerCase().trim();
  return value !== 'false' && value !== '0';
}

/**
 * Escape special characters for Telegram MarkdownV2 format.
 * Required chars: _ * [ ] ( ) ~ ` > # + - = | { } . !
 */
function escapeTelegramMarkdown(text: string): string {
  return text.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Send Telegram message to a single chat.
 * @throws Error if Telegram API returns non-200 status
 */
async function sendTelegramMessageToChat(
  token: string,
  chatId: string,
  text: string
): Promise<unknown> {
  const endpoint = `${TELEGRAM_API_BASE}${token}/sendMessage`;
  
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    }),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Telegram API error (${response.status}): ${errorText}`);
  }
  
  return await response.json();
}

/**
 * Send notification to all configured chat IDs in parallel.
 * Non-blocking: failures are logged but don't throw.
 */
async function sendTelegramMessage(
  env: CloudflareBindings,
  text: string
): Promise<void> {
  const token = env.BGREPS_TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    console.warn('[Telegram] Bot token not configured, skipping notification');
    return;
  }
  
  const chatIds = parseChatIds(env);
  if (chatIds.length === 0) {
    console.warn('[Telegram] No chat IDs configured, skipping notification');
    return;
  }
  
  // Send to all chats in parallel for speed
  const results = await Promise.allSettled(
    chatIds.map(chatId => sendTelegramMessageToChat(token, chatId, text))
  );
  
  // Log any failures (non-blocking)
  results.forEach((result, idx) => {
    if (result.status === 'rejected') {
      console.error(`[Telegram] Failed to send to chat ${chatIds[idx]}:`, result.reason);
    } else {
      console.log(`[Telegram] Successfully sent notification to chat ${chatIds[idx]}`);
    }
  });
}

/**
 * Format notification message for new guest request submission.
 */
function formatNewRequestNotification(data: NewRequestNotificationData): string {
  const {
    requestId,
    submitterName,
    message,
    hasRepeaterSuggestion,
    repeaterCallsign,
    country,
  } = data;
  
  const lines: string[] = [];
  
  // Header
  lines.push(`🔔 *New Repeater Request* \\#${requestId}`);
  lines.push('');
  
  // Submitter info
  lines.push(`👤 From: ${escapeTelegramMarkdown(submitterName)}`);
  if (country) {
    lines.push(`🌍 Location: ${escapeTelegramMarkdown(country)}`);
  }
  lines.push('');
  
  // Message preview (first 200 chars)
  if (message) {
    const preview = message.length > 200 ? message.substring(0, 200) + '...' : message;
    lines.push('📝 Message:');
    lines.push(`"${escapeTelegramMarkdown(preview)}"`);
    lines.push('');
  }
  
  // Repeater suggestion
  if (hasRepeaterSuggestion) {
    if (repeaterCallsign) {
      lines.push(`📡 Repeater: ${escapeTelegramMarkdown(repeaterCallsign)} \\(suggested\\)`);
    } else {
      lines.push('📡 Repeater details included');
    }
    lines.push('');
  }
  
  // Footer (admin panel link would go here if BASE_URL available)
  lines.push('_Awaiting review in admin panel_');
  
  return lines.join('\n');
}

/**
 * Format notification message for resolved guest request (approved/rejected/archived).
 */
function formatResolvedRequestNotification(data: ResolvedRequestNotificationData): string {
  const {
    requestId,
    submitterName,
    status,
    action,
    repeaterCallsign,
    resolvedBy,
    adminNotes,
  } = data;
  
  const lines: string[] = [];
  
  // Header with status emoji
  const emoji = status === 'approved' ? '✅' : status === 'rejected' ? '❌' : '📦';
  const statusText = status.charAt(0).toUpperCase() + status.slice(1);
  lines.push(`${emoji} *Request ${escapeTelegramMarkdown(statusText)}* \\#${requestId}`);
  lines.push('');
  
  // Repeater info (for approved)
  if (status === 'approved' && repeaterCallsign) {
    const actionText = action === 'created' ? 'created' : 'updated';
    lines.push(`📡 Repeater: ${escapeTelegramMarkdown(repeaterCallsign)} \\(${actionText}\\)`);
  }
  
  // Submitter
  lines.push(`👤 Requested by: ${escapeTelegramMarkdown(submitterName)}`);
  
  // Resolver
  if (resolvedBy) {
    lines.push(`👨‍💼 ${escapeTelegramMarkdown(statusText)} by: ${escapeTelegramMarkdown(resolvedBy)}`);
  }
  
  // Admin notes (truncated to 200 chars for privacy)
  if (adminNotes && adminNotes.trim()) {
    lines.push('');
    const notePreview = adminNotes.length > 200 ? adminNotes.substring(0, 200) + '...' : adminNotes;
    lines.push('💬 Notes:');
    lines.push(`"${escapeTelegramMarkdown(notePreview)}"`);
  }
  
  return lines.join('\n');
}

/**
 * Send notification when a new guest request is submitted.
 * Non-blocking: failures are silently logged.
 */
export async function notifyNewGuestRequest(
  env: CloudflareBindings,
  data: NewRequestNotificationData
): Promise<void> {
  if (!isConfigured(env)) {
    return; // Silently skip if not configured
  }
  
  try {
    const message = formatNewRequestNotification(data);
    await sendTelegramMessage(env, message);
  } catch (error) {
    console.error('[Telegram] Failed to send new request notification:', error);
  }
}

/**
 * Send notification when a guest request is resolved (approved/rejected/archived).
 * Non-blocking: failures are silently logged.
 */
export async function notifyGuestRequestResolved(
  env: CloudflareBindings,
  data: ResolvedRequestNotificationData
): Promise<void> {
  if (!isConfigured(env)) {
    return; // Silently skip if not configured
  }
  
  // Skip rejection notifications if disabled
  if (data.status === 'rejected' && !shouldNotifyRejections(env)) {
    console.log('[Telegram] Rejection notifications disabled, skipping');
    return;
  }
  
  // Skip archived notifications (low priority status change)
  if (data.status === 'archived') {
    console.log('[Telegram] Archived status, skipping notification');
    return;
  }
  
  try {
    const message = formatResolvedRequestNotification(data);
    await sendTelegramMessage(env, message);
  } catch (error) {
    console.error('[Telegram] Failed to send resolved request notification:', error);
  }
}

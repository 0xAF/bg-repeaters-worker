/**
 * Telegram Bot API integration for guest request notifications.
 * 
 * Sends notifications to admin users who have configured their personal Telegram chat ID
 * when guest requests are submitted or resolved (approved/rejected).
 * 
 * Environment variables:
 * - BGREPS_TELEGRAM_BOT_TOKEN: Bot token from @BotFather (required for notifications)
 */

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

type AdminNotificationRecipient = {
  username: string;
  telegram_id: string;
};

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
 * Escape special characters for Telegram MarkdownV2 format.
 * Required chars to escape: _ * [ ] ( ) ~ ` > # + - = | { } . ! \
 */
function escapeTelegramMarkdown(text: string): string {
  return text.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Send Telegram message to a single user.
 * @throws Error if Telegram API returns non-200 status
 */
async function sendTelegramMessageToUser(
  token: string,
  chatId: string,
  text: string
): Promise<unknown> {
  const endpoint = `${TELEGRAM_API_BASE}${token}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true,
  };
  console.log('[Telegram] Message text length:', text.length);
  console.log('[Telegram] Calling endpoint for chat:', chatId);
  
  try {
    console.log('[Telegram] Starting fetch...');
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    
    console.log('[Telegram] Fetch completed, status:', response.status);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Telegram] API error:', response.status, 'body:', errorText);
      throw new Error(`Telegram API error (${response.status}): ${errorText}`);
    }
    
    const result = await response.json();
    console.log('[Telegram] API success, message sent');
    return result;
  } catch (error) {
    console.error('[Telegram] Exception in sendTelegramMessageToUser:', String(error));
    throw error;
  }
}

/**
 * Send notification to all admin recipients in parallel.
 * Non-blocking: failures are logged but don't throw.
 */
async function notifyAdmins(
  token: string | undefined,
  admins: AdminNotificationRecipient[],
  text: string
): Promise<void> {
  if (!token?.trim()) {
    console.warn('[Telegram] Bot token not configured, skipping notification');
    return;
  }
  
  if (admins.length === 0) {
    console.log('[Telegram] No admins with Telegram IDs configured, skipping notification');
    return;
  }
  
  // Send to all admins in parallel for speed
  console.log('[Telegram] Formatting message for', admins.length, 'admins. Message length:', text.length);
  const results = await Promise.allSettled(
    admins.map(admin => {
      console.log('[Telegram] Sending to admin:', admin.username, 'chat_id:', admin.telegram_id);
      return sendTelegramMessageToUser(token, admin.telegram_id, text);
    })
  );
  
  console.log('[Telegram] Promise.allSettled results:', results.length, 'results');
  
  // Log results (non-blocking)
  results.forEach((result, idx) => {
    const admin = admins[idx];
    if (result.status === 'rejected') {
      console.error(`[Telegram] Failed to send to admin ${admin.username}:`, result.reason);
    } else {
      console.log(`[Telegram] Successfully sent notification to admin ${admin.username}`);
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
  
  // Footer
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
    lines.push(`🔧 ${escapeTelegramMarkdown(statusText)} by: ${escapeTelegramMarkdown(resolvedBy)}`);
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
 * 
 * @param env Cloudflare environment bindings
 * @param admins Array of admin users with Telegram IDs configured
 * @param data Request submission details
 */
export async function notifyAdminsNewRequest(
  env: CloudflareBindings,
  admins: AdminNotificationRecipient[],
  data: NewRequestNotificationData
): Promise<void> {
  try {
    const token = env.BGREPS_TELEGRAM_BOT_TOKEN?.trim();
    const message = formatNewRequestNotification(data);
    await notifyAdmins(token, admins, message);
  } catch (error) {
    console.error('[Telegram] Failed to send new request notification:', error);
  }
}

/**
 * Send notification when a guest request is resolved (approved/rejected/archived).
 * Non-blocking: failures are silently logged.
 * 
 * @param env Cloudflare environment bindings
 * @param admins Array of admin users with Telegram IDs configured
 * @param data Request resolution details
 */
export async function notifyAdminsApproved(
  env: CloudflareBindings,
  admins: AdminNotificationRecipient[],
  data: ResolvedRequestNotificationData
): Promise<void> {
  if (data.status !== 'approved') {
    console.warn('[Telegram] notifyAdminsApproved called with non-approved status');
    return;
  }
  
  try {
    const token = env.BGREPS_TELEGRAM_BOT_TOKEN?.trim();
    const message = formatResolvedRequestNotification(data);
    await notifyAdmins(token, admins, message);
  } catch (error) {
    console.error('[Telegram] Failed to send approval notification:', error);
  }
}

/**
 * Send notification when a guest request is rejected.
 * Non-blocking: failures are silently logged.
 * 
 * @param env Cloudflare environment bindings
 * @param admins Array of admin users with Telegram IDs configured
 * @param data Request rejection details
 */
export async function notifyAdminsRejected(
  env: CloudflareBindings,
  admins: AdminNotificationRecipient[],
  data: ResolvedRequestNotificationData
): Promise<void> {
  if (data.status !== 'rejected') {
    console.warn('[Telegram] notifyAdminsRejected called with non-rejected status');
    return;
  }
  
  try {
    const token = env.BGREPS_TELEGRAM_BOT_TOKEN?.trim();
    const message = formatResolvedRequestNotification(data);
    await notifyAdmins(token, admins, message);
  } catch (error) {
    console.error('[Telegram] Failed to send rejection notification:', error);
  }
}

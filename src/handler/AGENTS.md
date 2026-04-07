# handler/

Inbound message pipeline and outbound media dispatch. This is where Feishu events become opencode commands, and where agent file output gets uploaded back to Feishu.

## Files

### `message-handler.ts`
Core inbound pipeline. Receives normalized messages from `FeishuPlugin`, then:
1. Filters out messages that don't @mention the bot (uses `botOpenId` to check)
2. Handles text, post, image, and file message types (downloads images/files from Feishu)
3. Includes quoted message context if the user is replying to a previous message
4. Injects Lark context as a signature block appended to the first message per session
5. POSTs to opencode `/session/{id}/message`
6. Kicks off `StreamingBridge` to listen for the response
7. Calls `sendDetectedFiles` via `outbound-media.ts` once the session goes idle
### `command-handler.ts`
Handles slash commands typed in Feishu: `/new`, `/bindmodel`,`/sessions`, `/connect`, `/compact`, `/share`, `/abort`, `/help`.

Key detail: the currently connected session is pinned at the top of the `/sessions` list regardless of API ordering. Sessions are displayed as interactive cards with clickable buttons to connect./bindmodel sessionid modelid to bind session and model.

### `outbound-media.ts`
Detects file paths in agent response text using regex, then uploads matching files back to Feishu as images or attachments.

Security model:
- Paths are checked against an allowlist of permitted directories **before** any filesystem access (string prefix check avoids unnecessary FS calls)
- `fs.realpath()` resolves symlinks before the final allowlist check, preventing TOCTOU path traversal attacks
- Hard limit: `MAX_UPLOAD_BYTES = 20 * 1024 * 1024` (20 MB). Files over this limit are logged with a warning and skipped.

Upload routing: `.png`/`.jpg`/`.jpeg`/`.gif`/`.webp` go via `uploadImage`; everything else goes via `uploadFile`.

### `streaming-integration.ts`
SSE-to-CardKit bridge (also called `StreamingBridge` in the root docs).

- Subscribes to `EventProcessor` events for a specific session
- Accumulates `TextDelta` chunks via queue-based serialization to prevent rate-limit issues
- On `SessionIdle`: flushes the final card, then calls `sendDetectedFiles` to trigger outbound media upload
- On `ToolStart`/`ToolEnd`: updates the progress card via `ProgressTracker`

### `interactive-handler.ts`
Handles card action callbacks (button clicks). Currently serves permission approval cards and question/clarification cards. Receives POSTs from the webhook server and translates them into opencode API calls or session commands.

## Gotchas

- `botOpenId` must be fetched at startup via `getBotInfo()` before `MessageHandler` can filter @mentions. If it's undefined, group messages are **ignored** with a warning log (not processed).
- `sendDetectedFiles` is called only after `SessionIdle`, not during streaming, to avoid partial-file uploads.

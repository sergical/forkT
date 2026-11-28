# Welcome page

forkT opens the [main coordinator](./t3-fork.md) on first launch. Its Welcome page lists the agents on your computer, recent projects from your Claude Code, Codex, and Pi history, and the T3 Code mobile app.

- Reopen it anytime from **Settings → About → Welcome page → Open**.
- Hosted `app.t3.codes` skips this page and prompts you to sign in to T3 Connect and run `t3 connect` on your computer instead.

## Agents

forkT lists detected agents first (ready ones on top), followed by **Add more agents** for all other supported providers:

- **Turn on**: Enables a disabled provider and checks its install and sign-in status.
- **Claude Code**: **Install** or **Sign in** opens a setup terminal using the vendor's installer (so **Update now** keeps working in Settings).
- **Codex**: **Set up** offers ChatGPT sign-in or your existing Codex CLI.
- **Outdated or other agents**: **Update** or selecting the agent opens its page in **Settings → Providers**. **Browse** opens the ACP Registry.
- **Desktop CLI**: Click **Add to PATH** if the `t3` command isn't yet on your shell `PATH`.

Click **Start** once at least one agent is ready, or **Start without an agent** to enter the app immediately (checked projects still import).

## Phone

Select **Set up** to scan the QR code for iOS or Android. Open **Sharing & access** to pair the mobile app or enable T3 Connect.

## Projects and conversation import

forkT scans directories used by Claude Code, Codex, and Pi (turn on Pi under **Add more agents** to include Pi sessions).

- Git repositories active in the last 30 days with at least three conversations are pre-selected (excluding already-added projects, Codex scratch directories, and `Downloads`). Use **Review all** to customize the selection.
- Conversations active in the last 30 days are imported so you can continue them in T3 Code.

### Import limits

Conversation import is best-effort:

- Keeps the first user prompt and the most recent visible user/assistant messages (up to 200 messages total), omitting tool activity and attachments.
- Skips malformed/empty sessions, files over 4 GiB, sessions over 32 MiB of kept text/metadata, or sessions with over 100,000 records.
- Each import pass reads up to 100 conversations and 4 GiB per project. Reopen the Welcome page and select the project in **Review all** to continue importing a larger batch; already-imported conversations are skipped.

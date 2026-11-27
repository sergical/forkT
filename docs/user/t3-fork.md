# forkT

forkT is an independent fork of [T3 Code](https://github.com/pingdotgg/t3code). Its desktop build is distributed locally. Visit [forkT on GitHub](https://github.com/sergical/forkT) for the project.

The home screen opens your main coordinator for work across projects. For work in one project, open its folder in the sidebar and select **Coordinator**. Send a message there to start a turn or queue it behind work already in progress. Open **Settings → Memories** from Settings, the sidebar shortcut, or with **⌘K** to browse saved memory. Open **Inbox** below **Main coordinator**, or press **⌘2** on macOS. **⌘1** opens Main and ordinary sidebar destinations start at **⌘3**. Project Inbox, coordinator launch, and Dream are also under **Settings → Threads**. Return to that conversation for new work; the coordinator can delegate tasks into normal threads. You can change a coordinator's model and permission mode in its composer.

In the sidebar’s folder view, each project coordinator stays at the top of its folder. Choose **Show threads** for its pinned, active, snoozed, and settled work. Save decisions, preferences, and lessons in Memories. Project memory is shared by that project's threads and worktrees. The main coordinator has its own notes for cross-project work and conversations outside a project. Personal preferences can be included across projects on the same environment. Relevant notes are included in later agent turns; current instructions and code still take precedence. Read an entry to see its source excerpts and revisions. Forgetting removes its saved content, source copies, and history from memory; it does not erase original conversations or context already delivered to an agent.

Use **Dream about this project** after some work has finished. It starts a separate review of up to 40 recent messages and a saved memory index, using the project coordinator's model. The review proposes lessons in plan mode. It does not accept memories or change code. Inspect the proposals and tell your coordinator which supported lessons to save. Stop a review with the normal thread controls. Repeated requests reuse an active review or an unchanged snapshot.

The [delegation guide](t3-fork-model-routing.md) explains how coordinators choose an account and model for child tasks.

Answer questions, review plans, and approve or decline requests in **Inbox**. The sidebar shows the number of decisions waiting. Each item links to the thread that asked, and Back returns to your place in the queue. A recorded answer clears the item unless the agent asks for another decision. When the agent that asked marks one option as its recommendation, Inbox labels it **Recommended** and starts with it selected; nothing is sent until you press Send. Memory and coordinator state live on the project's environment; they are not synchronized between machines.

To share new messages from one conversation with Sentry, open its thread menu and turn on **Send new messages and replies to Sentry**. You can turn it off in the same menu. Sharing starts off for each conversation, including workers.

In **Sentry → Explore → Agents**, the LLM call count shows how many provider turns forkT observed. A provider can make several internal requests during one turn. The summary shows the last user input for each turn and groups its assistant updates. To see an initial question, a mid-turn instruction, and progress in their original order, open the chat span and read its input and output messages by their `ordinal` values.

The fork defaults to its own data directory, `~/.t3-fork-lab`. Its memory schema has a separate migration history from upstream T3 Code. An explicit home directory still takes precedence.

# T3 fork

Open **T3 fork** from the sidebar or command palette. Choose a project, then open its coordinator. Return to that conversation for new work; the coordinator can delegate tasks into normal threads. The main coordinator is a separate conversation for work across projects in the same environment. You can change a coordinator's model and permission mode in its composer.

Save decisions, preferences, and lessons in Memory. Project memory is shared by that project's threads and worktrees. Personal preferences are separate and can be included across projects on the same environment. Relevant notes are included in later agent turns; current instructions and code still take precedence. Read an entry to see its source excerpts and revisions. Forgetting removes its saved content, source copies, and history from memory; it does not erase original conversations or context already delivered to an agent.

Use **Dream about this project** after some work has finished. It starts a separate review of up to 40 recent messages and a saved memory index, using the project coordinator's model. The review proposes lessons in plan mode. It does not accept memories or change code. Inspect the proposals and tell your coordinator which supported lessons to save. Stop a review with the normal thread controls. Repeated requests reuse an active review or an unchanged snapshot.

The inbox links to the original questions and approvals. Answer in that thread so the waiting agent receives your response. Memory and coordinator state live on the project's environment; they are not synchronized between machines.

The fork defaults to its own data directory, `~/.t3-fork-lab`. Its memory schema has a separate migration history from upstream T3. An explicit home directory still takes precedence.

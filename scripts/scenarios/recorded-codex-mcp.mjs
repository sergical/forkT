export async function callMcp(connection, method, params, id) {
  const { server, session } = connection;
  if (new URL(server.url).hostname !== "127.0.0.1")
    throw new Error("Expected isolated loopback server");
  const res = await fetch(server.url, {
    method: "POST",
    headers: {
      ...server.http_headers,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(session && { "mcp-session-id": session }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  connection.session = res.headers.get("mcp-session-id") ?? session;
  const body = await res.text();
  if (!res.ok) throw new Error("Fixture MCP request failed: " + res.status);
  if (id === undefined) return;
  const msg = JSON.parse(
    body.startsWith("{")
      ? body
      : body
          .split("\n")
          .find((line) => line.startsWith("data:"))
          .slice(5),
  );
  if (msg.error || msg.result?.isError)
    throw new Error(msg.error?.message ?? msg.result.content[0].text);
  return msg.result;
}

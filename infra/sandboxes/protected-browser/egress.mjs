import { once } from "node:events";
import { connect, createServer } from "node:net";

export async function startEgressRelay() {
  const server = createServer((client) => {
    const proxy = connect("/run/protected-browser/egress.sock");
    client.on("error", () => proxy.destroy());
    proxy.on("error", () => client.destroy());
    client.once("close", () => proxy.destroy());
    proxy.once("close", () => client.destroy());
    client.pipe(proxy).pipe(client);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    launchOptions: {
      proxy: { server: `http://127.0.0.1:${server.address().port}`, bypass: "<-loopback>" },
      args: ["--disable-quic"],
    },
    close: () => server.close(),
  };
}

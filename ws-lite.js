// Tiny WebSocket server (RFC 6455), just what the game needs: text messages, ping/pong, close.
// No dependencies, so the server runs with plain Node.
"use strict";
const crypto = require("crypto");
const { EventEmitter } = require("events");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

class Conn extends EventEmitter {
  constructor(socket, maxPayload) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.readyState = 1;
    this.buf = Buffer.alloc(0);
    socket.setNoDelay(true);
    socket.on("data", d => this._onData(d));
    socket.on("close", () => this._closed());
    socket.on("error", () => this._closed());
  }
  get bufferedAmount() { return this.socket.writableLength; }

  _closed() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
  _frame(opcode, payload) {
    const len = payload.length;
    let head;
    if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
    else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    head[0] = 0x80 | opcode;
    return Buffer.concat([head, payload]);
  }
  send(text) {
    if (this.readyState !== 1) return;
    this.socket.write(this._frame(1, Buffer.from(text, "utf8")));
  }
  ping() { if (this.readyState === 1) this.socket.write(this._frame(9, Buffer.alloc(0))); }
  terminate() { this.socket.destroy(); this._closed(); }

  _onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (!masked || len > this.maxPayload) { this.terminate(); return; } // clients must mask; no huge messages
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);

      if (opcode === 1) this.emit("message", payload.toString("utf8"));
      else if (opcode === 8) { try { this.socket.end(this._frame(8, Buffer.alloc(0))); } catch (e) {} this._closed(); return; }
      else if (opcode === 9) this.socket.write(this._frame(10, payload));
      else if (opcode === 10) this.emit("pong");
      // binary and fragmented messages are not used by the game and are ignored
    }
  }
}

// Attach to an http server; calls onConnection(conn, req) for each new socket on `path`.
function attach(server, { path, maxPayload = 4096 }, onConnection) {
  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url, "http://x");
    const key = req.headers["sec-websocket-key"];
    if (url.pathname !== path || !key || String(req.headers.upgrade).toLowerCase() !== "websocket") {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
    );
    onConnection(new Conn(socket, maxPayload), req);
  });
}

module.exports = { attach };

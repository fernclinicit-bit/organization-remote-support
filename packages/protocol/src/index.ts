export type PeerRole = "agent" | "controller";

export type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

export type SignalMessage =
  | { type: "hello"; sessionId: string; joinToken: string; role: PeerRole }
  | { type: "peer-ready"; iceServers?: IceServerConfig[]; relayAvailable?: boolean }
  | { type: "error"; code: string; message: string; retryable?: boolean }
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice-candidate"; candidate: unknown }
  | { type: "consent"; granted: boolean }
  | { type: "end"; reason?: string };

export function isSignalMessage(value: unknown): value is SignalMessage {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return ["hello", "peer-ready", "error", "offer", "answer", "ice-candidate", "consent", "end"].includes(String(type));
}

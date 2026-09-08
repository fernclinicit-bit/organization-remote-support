export type PeerRole = "agent" | "controller";

export type SignalMessage =
  | { type: "hello"; sessionId: string; joinToken: string; role: PeerRole }
  | { type: "peer-ready" }
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice-candidate"; candidate: unknown }
  | { type: "consent"; granted: boolean }
  | { type: "end"; reason?: string };

export function isSignalMessage(value: unknown): value is SignalMessage {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return ["hello", "peer-ready", "offer", "answer", "ice-candidate", "consent", "end"].includes(String(type));
}

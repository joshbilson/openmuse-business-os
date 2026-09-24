export type VoiceInvitation = { status: string; expiresAt: string };

export function canAnswerInvitation(invitation: VoiceInvitation, now = Date.now()) {
  return (
    invitation.status === "ringing" &&
    Number.isFinite(Date.parse(invitation.expiresAt)) &&
    Date.parse(invitation.expiresAt) > now
  );
}

// An integration must explicitly implement this interface. Nothing is sent or logged by default.
export const disabledMailAdapter = Object.freeze({ enabled: false, async send() { throw new Error('Email delivery is not configured') } })
// send({kind: 'verify'|'reset', to: email, token: rawSingleUseToken, expiresAt: ISODate})
// Adapter contract: deliver privately, never log token/data, resolve only after accepting delivery,
// reject promptly on failure. The service imposes a 5-second timeout and activates tokens only on success.

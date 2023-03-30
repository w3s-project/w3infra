import * as UcantoClient from '@ucanto/client'
import * as principal from '@ucanto/principal'
import * as Signer from '@ucanto/principal/ed25519'

/**
 * @param {import('@ucanto/interface').Principal} audience
 */
export async function createSpace (audience) {
  const space = await Signer.generate()
  const spaceDid = space.did()

  return {
    proof: await UcantoClient.delegate({
      issuer: space,
      audience,
      capabilities: [{ can: '*', with: spaceDid }]
    }),
    spaceDid
  }
}

export function createAccount () {
  return principal.Absentee.from({ id: 'did:mailto:foo' })
}

import * as Server from '@ucanto/server'
import * as Upload from '@web3-storage/access/capabilities/upload'

/**
 * @param {import('../types').UploadServiceContext} context
 */
export function uploadListProvider(context) {
  return Server.provide(
    Upload.list,
    async ({ capability }) => {
      // Only use capability account for now to check if account is registered.
      // This must change to access account/info!!
      // We need to use https://github.com/web3-storage/w3protocol/blob/9d4b5bec1f0e870233b071ecb1c7a1e09189624b/packages/access/src/agent.js#L270
      const account = capability.with

      // TODO: Page, Size

      return await context.uploadTable.list(account)
  })
}

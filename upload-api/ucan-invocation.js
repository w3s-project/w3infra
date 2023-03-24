import * as CAR from '@ucanto/transport/car'
import * as CBOR from '@ucanto/transport/cbor'
import * as UCAN from '@ipld/dag-ucan'
import * as Link from 'multiformats/link'
import { fromString as uint8arrayFromString } from 'uint8arrays/from-string'

import {
  BadBodyError,
  BadContentTypeError,
  NoTokenError,
  ExpectedBasicStringError,
  NoValidTokenError,
  NoInvocationFoundForGivenReceiptError,
  NoCarFoundForGivenReceiptError
} from './errors.js'

export const CONTENT_TYPE = {
  WORKFLOW: 'application/invocations+car',
  RECEIPT: 'application/receipt+dag-cbor'
}

export const STREAM_TYPE = {
  WORKFLOW: 'workflow',
  RECEIPT: 'receipt'
}

/**
 * @typedef {import('./types').UcanLogCtx} UcanLogCtx
 * @typedef {import('./types').WorkflowCtx} WorkflowCtx
 * @typedef {import('./types').ReceiptBlockCtx} ReceiptBlockCtx
 * @typedef {import('./types').Workflow} Workflow
 * @typedef {import('./types').ReceiptBlock} ReceiptBlock
 */

/**
 * @param {import('aws-lambda').APIGatewayProxyEventV2} request
 * @param {UcanLogCtx} ctx
 */
export async function processUcanLogRequest (request, ctx) {
  const token = getTokenFromRequest(request)
  if (token !== ctx.basicAuth) {
    throw new NoValidTokenError('invalid Authorization credentials provided')
  }

  if (!request.body) {
    throw new BadBodyError('service requests are required to have body')
  }
  const bytes = Buffer.from(request.body, 'base64')

  const contentType = request.headers['content-type'] || ''
  if (contentType === CONTENT_TYPE.WORKFLOW) {
    return await processWorkflow(bytes, ctx)
  } else if (contentType === CONTENT_TYPE.RECEIPT) {
    return await processInvocationReceipt(bytes, ctx)
  }
  throw new BadContentTypeError()
}

/**
 * @param {Uint8Array} bytes
 * @param {WorkflowCtx} ctx
 */
export async function processWorkflow (bytes, ctx) {
  const worflow = await parseWorkflow(bytes)

  // persist workflow and its invocations
  await persistWorkflow(worflow, ctx.invocationBucket, ctx.workflowBucket)

  // Put workflow invocations to UCAN stream
  await ctx.kinesisClient?.putRecords({
    Records: worflow.invocations.map(invocation => ({
      Data: uint8arrayFromString(
        JSON.stringify({
          carCid: worflow.cid.toString(),
          value: invocation,
          ts: Date.now(),
          type: STREAM_TYPE.WORKFLOW
        })
      ),
      // https://docs.aws.amazon.com/streams/latest/dev/key-concepts.html
      // A partition key is used to group data by shard within a stream.
      // It is required, and now we are starting with one shard. We need to study best partition key
      PartitionKey: 'key',
    })),
    StreamName: ctx.streamName,
  })

  return worflow
}

/**
 * @param {Uint8Array} bytes
 * @param {ReceiptBlockCtx} ctx
 */
export async function processInvocationReceipt (bytes, ctx) {
  const receiptBlock = await parseReceiptCbor(bytes)
  const workflowCid = await ctx.invocationBucket.getWorkflowLink(receiptBlock.data.ran.toString())
  if (!workflowCid) {
    throw new NoCarFoundForGivenReceiptError()
  }

  const workflowBytes = await ctx.workflowBucket.get(workflowCid)
  if (!workflowBytes) {
    throw new NoCarFoundForGivenReceiptError()
  }

  const workflow = await parseWorkflow(workflowBytes)
  const invocation = workflow.invocations.find(invocation => invocation.cid.toString() === receiptBlock.data.ran.toString())
  if (!invocation) {
    throw new NoInvocationFoundForGivenReceiptError()
  }

  // persist receipt
  await persistReceipt(receiptBlock, ctx.invocationBucket, ctx.taskBucket)

  // Put Receipt to UCAN Stream
  await ctx.kinesisClient?.putRecord({
    Data: uint8arrayFromString(
      JSON.stringify({
        carCid: workflow.cid.toString(),
        invocationCid: receiptBlock.cid.toString(),
        value: invocation,
        ts: Date.now(),
        type: STREAM_TYPE.RECEIPT,
        out: receiptBlock.data.out
      })
    ),
    // https://docs.aws.amazon.com/streams/latest/dev/key-concepts.html
    // A partition key is used to group data by shard within a stream.
    // It is required, and now we are starting with one shard. We need to study best partition key
    PartitionKey: 'key',
    StreamName: ctx.streamName,
  })

  return receiptBlock
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<Workflow>}
 */
export async function parseWorkflow (bytes) {
  const car = await CAR.codec.decode(bytes)
  if (!car.roots.length) {
    throw new Error('Invocations CAR must have one root')
  }

  const cid = car.roots[0].cid
  const invocations = car.roots.map(root => {
    // @ts-expect-error 'ByteView<unknown>' is not assignable to parameter of type 'ByteView<UCAN<Capabilities>>'
    const dagUcan = UCAN.decode(root.bytes)

    return {
      // Workaround for:
      // https://github.com/web3-storage/ucanto/issues/171
      // https://github.com/multiformats/js-multiformats/issues/228
      // @ts-ignore missing types
      att: /** @type {UCAN.Capabilities} */ (dagUcan.att.map(replaceAllLinkValues)),
      aud: dagUcan.aud.did(),
      iss: dagUcan.iss.did(),
      cid: root.cid.toString()
    }
  })

  return {
    bytes,
    cid,
    invocations,
  }
}

/**
 * Persist workflow with invocations to be handled by the router.
 * Persist index per invocation to which workflow they come from.
 *
 * @param {Workflow} workflow
 * @param {import('./types').InvocationBucket} invocationStore
 * @param {import('./types').WorkflowBucket} workflowStore
 */
export async function persistWorkflow (workflow, invocationStore, workflowStore) {
  const carCid = workflow.cid.toString()
  const tasks = [
    workflowStore.put(carCid, workflow.bytes),
    ...workflow.invocations.map(i => invocationStore.putWorkflowLink(i.cid, carCid))
  ]

  await Promise.all(tasks)
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<ReceiptBlock>}
 */
export async function parseReceiptCbor (bytes) {
  const data = await CBOR.codec.decode(bytes)
  const cid = await CBOR.codec.link(bytes)

  return {
    bytes,
    cid,
    data
  }
}

/**
 * @param {ReceiptBlock} receiptBlock
 * @param {import('./types').InvocationBucket} invocationBucket
 * @param {import('./types').TaskBucket} taskBucket
 */
export async function persistReceipt (receiptBlock, invocationBucket, taskBucket) {
  const invocationCid = receiptBlock.data.ran.toString()
  // TODO: For now we will use delegation CID as both invocation and task CID
  // Delegation CIDs are the roots in the received CAR and CID in the .ran field
  // of the received receipt.
  const taskCid = invocationCid

  await Promise.all([
    // Store invocation receipt block
    invocationBucket.putReceipt(
      invocationCid,
      receiptBlock.bytes
    ),
    // Store Task result
    (async () => {
      const taskResult = await CBOR.codec.write({
        out: receiptBlock.data.out
      })
      await taskBucket.putResult(taskCid, taskResult.bytes)
    })(),
    // Store task invocation link
    taskBucket.putInvocationLink(taskCid, invocationCid)
  ])
}

/**
 * @param {import('aws-lambda').APIGatewayProxyEventV2} request
 */
function getTokenFromRequest (request) {
  const authHeader = request.headers.authorization || ''
  if (!authHeader) {
    throw new NoTokenError('no Authorization header provided')
  }

  const token = parseAuthorizationHeader(authHeader)
  return token
}

/**
 * @param {string} header
 */
function parseAuthorizationHeader (header) {
  if (!header.toLowerCase().startsWith('basic ')) {
    throw new ExpectedBasicStringError('no basic Authorization header provided')
  }

  return header.slice(6)
}

/**
 * @param {any} value
 */
export const replaceAllLinkValues = (value) => {
  // Array with Links?
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (Link.isLink(value[i])) {
        value[i] = toJSON(value[i])
      } else {
        replaceAllLinkValues(value[i])
      }
    }
  }
  // Object with Links?
  else if (typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (Link.isLink(value[key])) {
        value[key] = toJSON(value[key])
      }
      replaceAllLinkValues(value[key])
    }
  }

  return value
}

/**
 * @template {import('multiformats').UnknownLink} Link
 * @param {Link} link
 */
export const toJSON = (link) =>
  /** @type {import('@web3-storage/upload-api').LinkJSON<Link>} */ ({
    '/': link.toString(),
  })

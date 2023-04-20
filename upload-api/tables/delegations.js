import { base32 } from 'multiformats/bases/base32'
import {
  DynamoDBClient,
  QueryCommand,
  BatchWriteItemCommand,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb'
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb'

import { CID } from 'multiformats/cid'
import {
  bytesToDelegations,
  delegationsToBytes
} from '@web3-storage/access/encoding'

/**
 * Abstraction layer to handle operations on Store Table.
 *
 * @param {string} region
 * @param {string} tableName
 * @param {import('../types').DelegationsBucket} bucket
 * @param {object} [options]
 * @param {string} [options.endpoint]
 */
export function createDelegationsTable (region, tableName, bucket, options = {}) {
  const dynamoDb = new DynamoDBClient({
    region,
    endpoint: options.endpoint,
  })

  return useDelegationsTable(dynamoDb, tableName, bucket)
}

/**
 * @param {DynamoDBClient} dynamoDb
 * @param {string} tableName
 * @param {import('../types').DelegationsBucket} bucket
 * @returns {import('../access-types').DelegationsStorage}
 */
export function useDelegationsTable (dynamoDb, tableName, bucket) {
  return {
    putMany: async (...delegations) => {
      if (delegations.length === 0) {
        return
      }
      await writeDelegations(bucket, delegations)
      // TODO: we should look at the return value of this BatchWriteItemCommand and either retry or clean up delegations that we fail to index
      await dynamoDb.send(new BatchWriteItemCommand({
        RequestItems: {
          [tableName]: delegations.map(d => ({
            PutRequest: {
              Item: marshall(
                createDelegationItem(d),
                { removeUndefinedValues: true })
            }
          })
          )
        }
      }))
    },
    count: async () => {
      const result = await dynamoDb.send(new DescribeTableCommand({
        TableName: tableName
      }))

      return BigInt(result.Table?.ItemCount ?? -1)
    },
    find: async function* find (query) {
      const cmd = new QueryCommand({
        TableName: tableName,
        // Limit: options.size || 20, // TODO should we introduce a limit here?
        KeyConditions: {
          audience: {
            ComparisonOperator: 'EQ',
            AttributeValueList: [{ S: query.audience }]
          }
        },
        AttributesToGet: ['cid']
      })
      const response = await dynamoDb.send(cmd)

      for (const result of response.Items ?? []) {
        const { cid } = unmarshall(result)
        yield cidToDelegation(bucket, CID.parse(cid))
      }
    }
  }
}

/**
 * TODO: fix the return type to use CID and DID string types
 * 
 * @param {import('@ucanto/interface').Delegation} d
 * @returns {{cid: string, audience: string, issuer: string}}}
 */
function createDelegationItem (d) {
  return {
    cid: d.cid.toString(),
    audience: d.audience.did(),
    issuer: d.issuer.did(),
  }
}

/** 
 * @param {import('../types').DelegationsBucket} bucket
 * @param {CID} cid
 * @returns {Promise<import('@ucanto/interface').Delegation>}
 */
async function cidToDelegation (bucket, cid) {
  const delegationCarBytes = await bucket.get(cid)
  if (!delegationCarBytes) {
    throw new Error(`failed to read car bytes for cid ${cid.toString(base32)}`)
  }
  const delegations = bytesToDelegations(delegationCarBytes)
  const delegation = delegations.find((d) => d.cid.equals(cid))
  if (!delegation) {
    throw new Error(`failed to parse delegation with expected cid ${cid.toString(base32)}`)
  }
  return delegation
}

/**
 * TODO: can we use the function in w3up access-api/src/models/delegations.js?
 * 
 * @param {import('../types').DelegationsBucket} bucket
 * @param {Iterable<import('@ucanto/interface').Delegation>} delegations
 */
async function writeDelegations (bucket, delegations) {
  return writeEntries(
    bucket,
    [...delegations].map((delegation) => {
      const carBytes = delegationsToBytes([delegation])
      const value = carBytes
      return /** @type {[key: CID, value: Uint8Array]} */ ([delegation.cid, value])
    })
  )
}

/**
 * TODO: can we use the function in w3up access-api/src/models/delegations.js?
 * 
 * @param {import('../types').DelegationsBucket} bucket
 * @param {Iterable<readonly [key: CID, value: Uint8Array ]>} entries
 */
async function writeEntries (bucket, entries) {
  await Promise.all([...entries].map(([key, value]) => bucket.put(key, value)))
}
import { handleSpaceBillingInstruction } from '../../lib/space-billing-queue.js'
import { startOfMonth, startOfLastMonth, } from '../../lib/util.js'
import { randomConsumer } from '../helpers/consumer.js'
import { randomCustomer } from '../helpers/customer.js'
import { randomLink } from '../helpers/dag.js'

/** @type {import('./api').TestSuite<import('./api').SpaceBillingQueueTestContext>} */
export const test = {
  'should do basic usage calculation for new space with single item added at snapshot time': async (/** @type {import('entail').assert} */ assert, ctx) => {
    const customer = randomCustomer()
    const consumer = await randomConsumer()
    const from = startOfLastMonth()
    const to = startOfMonth()
    const change = 1024 * 1024 * 1024 // 1GiB

    await ctx.spaceSnapshotStore.put({
      space: consumer.consumer,
      size: 0n,
      recordedAt: from,
      provider: consumer.provider,
      insertedAt: new Date()
    })

    await ctx.spaceDiffStore.put({
      provider: consumer.provider,
      space: consumer.consumer,
      customer: customer.customer,
      subscription: consumer.subscription,
      cause: randomLink(),
      change,
      receiptAt: from,
      insertedAt: new Date()
    })

    /** @type {import('../../lib/api.js').SpaceBillingInstruction} */
    const instruction = {
      customer: customer.customer,
      account: customer.account,
      product: customer.product,
      from,
      to,
      space: consumer.consumer,
      provider: consumer.provider
    }

    const handled = await handleSpaceBillingInstruction(instruction, ctx)
    assert.ok(handled.ok)

    const { ok: listing } = await ctx.usageStore.list({ customer: customer.customer, from })
    assert.ok(listing)

    assert.equal(listing.results.length, 1)
    assert.equal(
      listing.results[0].usage,
      // 1GiB for the whole period
      BigInt(change) * BigInt(to.getTime() - from.getTime())
    )

    const { ok: snap } = await ctx.spaceSnapshotStore.get({
      provider: consumer.provider,
      space: consumer.consumer,
      recordedAt: to
    })
    assert.ok(snap)
    assert.equal(snap.size, BigInt(change))
  },
  'should consider removals': async (/** @type {import('entail').assert} */ assert, ctx) => {
    const customer = randomCustomer()
    const consumer = await randomConsumer()
    const from = startOfLastMonth()
    const to = startOfMonth()
    const change = 1024 * 1024 * 1024 // 1GiB

    await ctx.spaceSnapshotStore.put({
      space: consumer.consumer,
      size: 0n,
      recordedAt: from,
      provider: consumer.provider,
      insertedAt: new Date()
    })

    // add 1GiB
    await ctx.spaceDiffStore.put({
      provider: consumer.provider,
      space: consumer.consumer,
      customer: customer.customer,
      subscription: consumer.subscription,
      cause: randomLink(),
      change,
      receiptAt: from,
      insertedAt: new Date()
    })

    // remove 1GiB
    await ctx.spaceDiffStore.put({
      provider: consumer.provider,
      space: consumer.consumer,
      customer: customer.customer,
      subscription: consumer.subscription,
      cause: randomLink(),
      change: -change,
      // removed exactly half way through the month
      receiptAt: new Date(from.getTime() + ((to.getTime() - from.getTime()) / 2)),
      insertedAt: new Date()
    })

    /** @type {import('../../lib/api.js').SpaceBillingInstruction} */
    const instruction = {
      customer: customer.customer,
      account: customer.account,
      product: customer.product,
      from,
      to,
      space: consumer.consumer,
      provider: consumer.provider
    }

    const handled = await handleSpaceBillingInstruction(instruction, ctx)
    assert.ok(handled.ok)

    const { ok: listing } = await ctx.usageStore.list({ customer: customer.customer, from })
    assert.ok(listing)

    assert.equal(listing.results.length, 1)
    assert.equal(
      listing.results[0].usage,
      // 1GiB for half the period
      BigInt(change) * BigInt(to.getTime() - from.getTime()) / 2n
    )

    const { ok: snap } = await ctx.spaceSnapshotStore.get({
      provider: consumer.provider,
      space: consumer.consumer,
      recordedAt: to
    })
    assert.ok(snap)
    assert.equal(snap.size, 0n)
  },
  'should consider existing space size': async (/** @type {import('entail').assert} */ assert, ctx) => {
    const customer = randomCustomer()
    const consumer = await randomConsumer()
    const size = BigInt(1024 * 1024 * 1024 * 1024) // 1TiB
    const from = startOfLastMonth()
    const to = startOfMonth()
    const change = 1024 * 1024 * 1024 // 1GiB

    await ctx.spaceSnapshotStore.put({
      space: consumer.consumer,
      size,
      recordedAt: startOfLastMonth(),
      provider: consumer.provider,
      insertedAt: new Date()
    })

    /** @param {Date} today */
    const yesterday = today => {
      const yest = new Date(today.toISOString())
      yest.setUTCDate(today.getUTCDate() - 1)
      return yest
    }

    await ctx.spaceDiffStore.put({
      provider: consumer.provider,
      space: consumer.consumer,
      customer: customer.customer,
      subscription: consumer.subscription,
      cause: randomLink(),
      change,
      // store/add 24h prior to end of billing
      receiptAt: yesterday(to),
      insertedAt: new Date()
    })

    /** @type {import('../../lib/api.js').SpaceBillingInstruction} */
    const instruction = {
      customer: customer.customer,
      account: customer.account,
      product: customer.product,
      from,
      to,
      space: consumer.consumer,
      provider: consumer.provider
    }

    const handled = await handleSpaceBillingInstruction(instruction, ctx)
    assert.ok(handled.ok)

    const { ok: listing } = await ctx.usageStore.list({ customer: customer.customer, from })
    assert.ok(listing)

    assert.equal(listing.results.length, 1)
    assert.equal(
      listing.results[0].usage,
      // existing size for the period
      size * BigInt(to.getTime() - from.getTime())
      // + 1GiB for 1 day
      + BigInt(change) * BigInt(to.getTime() - yesterday(to).getTime())
    )

    const { ok: snap } = await ctx.spaceSnapshotStore.get({
      provider: consumer.provider,
      space: consumer.consumer,
      recordedAt: to
    })
    assert.ok(snap)
    assert.equal(snap.size, size + BigInt(change))
  }
}
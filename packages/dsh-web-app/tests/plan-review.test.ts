import test from 'node:test'
import assert from 'node:assert/strict'

import type { Question } from '../web/src/dsh/api.ts'
import {
  approveResponse,
  cancelResponse,
  declineResponse,
  planReviewOf,
} from '../web/src/dsh/plan-review.ts'

const PLAN = '# Ship the picker\n\n- read the store\n- render the rows\n'

const question = (): Question => ({
  id: 'plan-review',
  header: 'Plan review',
  question: 'Approve this plan and leave plan mode?',
  detail: PLAN,
  options: [
    { label: 'Approve', description: 'Leave plan mode; the plan is carried out from the next step.' },
    { label: 'Keep planning', description: 'Stay in plan mode; feedback goes back to the model.' },
  ],
  intent: { kind: 'plan-review', approve: 'Approve' },
})

test('planReviewOf narrows a valid binary plan-review request to its decision', () => {
  assert.deepEqual(planReviewOf([question()]), {
    id: 'plan-review',
    question: 'Approve this plan and leave plan mode?',
    plan: PLAN,
    approve: { label: 'Approve', description: 'Leave plan mode; the plan is carried out from the next step.' },
    decline: { label: 'Keep planning', description: 'Stay in plan mode; feedback goes back to the model.' },
  })
})

test('planReviewOf keeps decline absent when the asker offered approve alone', () => {
  const review = planReviewOf([{ ...question(), options: [{ label: 'Approve' }] }])
  assert.deepEqual(review, {
    id: 'plan-review',
    question: 'Approve this plan and leave plan mode?',
    plan: PLAN,
    approve: { label: 'Approve' },
  })
  assert.ok(review)
  assert.equal('decline' in review, false)
})

test('planReviewOf accepts an empty-string plan as a valid detail', () => {
  const review = planReviewOf([{ ...question(), detail: '' }])
  assert.ok(review)
  assert.equal(review.plan, '')
})

const declinedCases: [string, Question[]][] = [
  ['a batch of more than one question', [question(), question()]],
  ['no intent at all', [{ ...question(), intent: undefined }]],
  ['an intent without the plan as detail', [{ ...question(), detail: undefined }]],
  ['an intent whose approve names no option', [{
    ...question(), intent: { kind: 'plan-review', approve: 'Ship it' },
  }]],
  ['an intent with no options at all', [{ ...question(), options: undefined }]],
  ['a third option the card could not offer', [{
    ...question(),
    options: [{ label: 'Approve' }, { label: 'Keep planning' }, { label: 'Start over' }],
  }]],
  ['a multi-select decision', [{ ...question(), multiSelect: true }]],
]

for (const [name, questions] of declinedCases) {
  test(`planReviewOf declines ${name}, leaving the request to the generic flow`, () => {
    assert.equal(planReviewOf(questions), undefined)
  })
}

test('planReviewOf declines an empty batch', () => {
  assert.equal(planReviewOf([]), undefined)
})

test('approve/decline/cancel response envelopes match the wire contract exactly', () => {
  const review = planReviewOf([question()])
  assert.ok(review)
  assert.ok(review.decline)

  assert.deepEqual(approveResponse('s1', review), {
    ok: true,
    value: { sessionId: 's1', answer: { answers: [{ id: 'plan-review', selected: ['Approve'] }] } },
  })
  assert.deepEqual(declineResponse('s1', review), {
    ok: true,
    value: { sessionId: 's1', answer: { answers: [{ id: 'plan-review', selected: ['Keep planning'] }] } },
  })
  assert.deepEqual(cancelResponse('s1'), {
    ok: false,
    error: { code: 'cancelled', message: 'the user closed this question request', details: {} },
  })
})

test('decision responses echo the asker\'s own raw labels, never recomputed', () => {
  const review = planReviewOf([{
    ...question(),
    options: [
      { label: 'GO AHEAD' },
      { label: 'NOT YET', description: 'Give feedback instead.' },
    ],
    intent: { kind: 'plan-review', approve: 'GO AHEAD' },
  }])
  assert.ok(review)
  assert.ok(review.decline)

  assert.deepEqual(approveResponse('s1', review), {
    ok: true,
    value: { sessionId: 's1', answer: { answers: [{ id: 'plan-review', selected: ['GO AHEAD'] }] } },
  })
  assert.deepEqual(declineResponse('s1', review), {
    ok: true,
    value: { sessionId: 's1', answer: { answers: [{ id: 'plan-review', selected: ['NOT YET'] }] } },
  })
})

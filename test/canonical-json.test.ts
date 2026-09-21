import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  canonicalJson,
  compareUtf16CodeUnits,
  isCanonicalJsonValue,
} from '../src/core/canonical-json.ts'

/**
 * The six official JCS test vectors from RFC 8785's development portal
 * (github.com/cyberphone/json-canonicalization, testdata/input + output).
 * Inputs are parsed from the exact JSON text; expected outputs are embedded
 * with explicit escapes so control characters such as U+007F and U+0080 are
 * byte-exact.
 */
const OFFICIAL_VECTORS: ReadonlyArray<{ name: string; input: string; expected: string }> = [
  {
    name: 'arrays: array order preserved, objects inside sorted',
    input: '[\n  56,\n  {\n    "d": true,\n    "10": null,\n    "1": [ ]\n  }\n]\n',
    expected: '[56,{"1":[],"10":null,"d":true}]',
  },
  {
    name: 'french: locale-independent sorting',
    input:
      '{\n  "peach": "This sorting order",\n  "péché": "is wrong according to French",\n' +
      '  "pêche": "but canonicalization MUST",\n  "sin":   "ignore locale"\n}\n',
    expected:
      '{"peach":"This sorting order","péché":"is wrong according to French",' +
      '"pêche":"but canonicalization MUST","sin":"ignore locale"}',
  },
  {
    name: 'structures: recursive sorting, numeric keys sort as strings, empty key first',
    input:
      '{\n  "1": {"f": {"f": "hi","F": 5} ,"\\n": 56.0},\n  "10": { },\n  "": "empty",\n' +
      '  "a": { },\n  "111": [ {"e": "yes","E": "no" } ],\n  "A": { }\n}\n',
    expected:
      '{"":"empty","1":{"\\n":56,"f":{"F":5,"f":"hi"}},"10":{},"111":[{"E":"no","e":"yes"}],' +
      '"A":{},"a":{}}',
  },
  {
    name: 'unicode: decomposed sequences are preserved, never re-normalized',
    input: '{\n  "Unnormalized Unicode":"A\\u030a"\n}\n',
    expected: '{"Unnormalized Unicode":"Å"}',
  },
  {
    name: 'values: number and string serialization (RFC 8785 §3.2.2 sample)',
    input:
      '{\n  "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],\n' +
      '  "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",\n' +
      '  "literals": [null, true, false]\n}\n',
    expected:
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
      '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
  },
  {
    name: 'weird: UTF-16 code-unit key order, controls outside U+0000–U+001F literal',
    input:
      '{\n  "\\u20ac": "Euro Sign",\n  "\\r": "Carriage Return",\n  "\\u000a": "Newline",\n' +
      '  "1": "One",\n  "\\u0080": "Control\\u007f",\n  "\\ud83d\\ude02": "Smiley",\n' +
      '  "\\u00f6": "Latin Small Letter O With Diaeresis",\n' +
      '  "\\ufb33": "Hebrew Letter Dalet With Dagesh",\n' +
      '  "</script>": "Browser Challenge"\n}\n',
    expected:
      '{"\\n":"Newline","\\r":"Carriage Return","1":"One","</script>":"Browser Challenge",' +
      '"\u0080":"Control\u007f","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign",' +
      '"😂":"Smiley","דּ":"Hebrew Letter Dalet With Dagesh"}',
  },
]

describe('canonicalJson against the official RFC 8785 test vectors', () => {
  for (const vector of OFFICIAL_VECTORS) {
    it(vector.name, () => {
      assert.equal(canonicalJson(JSON.parse(vector.input) as never), vector.expected)
    })
  }

  it('produces the exact UTF-8 bytes documented in RFC 8785 §3.2.4', () => {
    const canonical = canonicalJson(JSON.parse(OFFICIAL_VECTORS[4]!.input) as never)
    const documentedBytes = Buffer.from(
      (
        '7b 22 6c 69 74 65 72 61 6c 73 22 3a 5b 6e 75 6c 6c 2c 74 72 75 65 2c 66 61 6c 73 65 5d 2c 22 6e 75 6d 62 65 72 73 22 3a ' +
        '5b 33 33 33 33 33 33 33 33 33 2e 33 33 33 33 33 33 33 2c 31 65 2b 33 30 2c 34 2e 35 2c 30 2e 30 30 32 2c 31 65 2d 32 37 5d ' +
        '2c 22 73 74 72 69 6e 67 22 3a 22 e2 82 ac 24 5c 75 30 30 30 66 5c 6e 41 27 42 5c 22 5c 5c 5c 5c 5c 22 2f 22 7d'
      ).replace(/ /g, ''),
      'hex',
    )
    assert.deepEqual(Buffer.from(canonical, 'utf8'), documentedBytes)
  })
})

describe('canonicalJson number serialization (RFC 8785 Appendix B samples)', () => {
  const SAMPLES: ReadonlyArray<[number, string]> = [
    [0, '0'],
    [-0, '0'],
    [5e-324, '5e-324'],
    [-5e-324, '-5e-324'],
    [1.7976931348623157e308, '1.7976931348623157e+308'],
    [-1.7976931348623157e308, '-1.7976931348623157e+308'],
    [9007199254740992, '9007199254740992'],
    [-9007199254740992, '-9007199254740992'],
    [2 ** 68, '295147905179352830000'],
    [9.999999999999997e22, '9.999999999999997e+22'],
    [1e23, '1e+23'],
    [1.0000000000000001e23, '1.0000000000000001e+23'],
    [999999999999999700000, '999999999999999700000'],
    [999999999999999900000, '999999999999999900000'],
    [1e21, '1e+21'],
    [9.999999999999997e-7, '9.999999999999997e-7'],
    [1e-6, '0.000001'],
    [333333333.3333332, '333333333.3333332'],
    [333333333.33333325, '333333333.33333325'],
    [333333333.3333333, '333333333.3333333'],
    [333333333.3333334, '333333333.3333334'],
    [333333333.33333343, '333333333.33333343'],
    [-0.0000033333333333333333, '-0.0000033333333333333333'],
    [1424953923781206.2, '1424953923781206.2'],
  ]

  for (const [value, expected] of SAMPLES) {
    it(`serializes ${expected}`, () => {
      assert.equal(canonicalJson(value), expected)
    })
  }
})

describe('canonicalJson string serialization', () => {
  it('uses the named escapes for the five JSON control characters', () => {
    assert.equal(canonicalJson('\b\t\n\f\r'), '"\\b\\t\\n\\f\\r"')
  })

  it('uses lowercase \\u escapes for other control characters', () => {
    assert.equal(canonicalJson('\u0000'), '"\\u0000"')
    assert.equal(canonicalJson('\u001f'), '"\\u001f"')
    assert.equal(canonicalJson('A\u000bB'), '"A\\u000bB"')
  })

  it('escapes only the two mandatory characters outside the control range', () => {
    assert.equal(canonicalJson('a"b\\c'), '"a\\"b\\\\c"')
  })

  it('emits slash, del (U+007F), and non-ASCII characters literally', () => {
    assert.equal(canonicalJson('/\u007fö€😀'), '"/\u007fö€😀"')
  })

  it('rejects lone surrogates in values and in property names', () => {
    assert.throws(() => canonicalJson('\uD800'), RangeError)
    assert.throws(() => canonicalJson('\uDEAD'), RangeError)
    assert.throws(() => canonicalJson('ok\uD800ok'), RangeError)
    assert.throws(() => canonicalJson({ '\uD800': 1 } as never), RangeError)
  })

  it('accepts surrogate pairs', () => {
    assert.equal(canonicalJson('\uD83D\uDE00'), '"😀"')
  })
})

describe('canonicalJson structure', () => {
  it('emits no whitespace between tokens', () => {
    assert.equal(canonicalJson({ a: [1, true, null], b: { c: 'x' } }), '{"a":[1,true,null],"b":{"c":"x"}}')
  })

  it('sorts keys recursively at every nesting level', () => {
    const nested = { z: { b: 1, a: 2 }, y: [{ m: 1, k: 2 }] }
    assert.equal(canonicalJson(nested), '{"y":[{"k":2,"m":1}],"z":{"a":2,"b":1}}')
  })

  it('sorts number-like keys as strings', () => {
    assert.equal(canonicalJson({ 10: null, 1: null, 2: null }), '{"1":null,"10":null,"2":null}')
  })

  it('produces identical output for identical logical payloads regardless of insertion order', () => {
    const first = { alpha: 1, beta: [true, { x: null, a: 's' }], gamma: 't' }
    const second = { gamma: 't', beta: [true, { a: 's', x: null }], alpha: 1 }
    assert.equal(canonicalJson(first), canonicalJson(second))
  })

  it('preserves array element order without sorting', () => {
    assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]')
  })

  it('serializes empty containers', () => {
    assert.equal(canonicalJson({}), '{}')
    assert.equal(canonicalJson([]), '[]')
    assert.equal(canonicalJson({ a: [], b: {} }), '{"a":[],"b":{}}')
  })

  it('serializes minus zero as 0', () => {
    assert.equal(canonicalJson({ n: -0 }), '{"n":0}')
  })

  it('rejects values outside the RFC 8785 data model', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      assert.throws(() => canonicalJson(bad as never), RangeError)
    }
    for (const bad of [undefined, 1n, Symbol('x'), () => 1, new Date(0)]) {
      assert.throws(() => canonicalJson(bad as never), TypeError)
    }
    assert.throws(() => canonicalJson({ nested: [undefined] } as never), TypeError)
  })
})

describe('compareUtf16CodeUnits', () => {
  it('sorts like the RFC 8785 plain-English example', () => {
    const sorted = ['b', '', 'ab', 'a', 'aa'].sort(compareUtf16CodeUnits)
    assert.deepEqual(sorted, ['', 'a', 'aa', 'ab', 'b'])
  })

  it('orders supplementary characters by leading surrogate, before U+FB33', () => {
    assert.ok(compareUtf16CodeUnits('\ud83d\ude02', '\ufb33') < 0)
    assert.ok(compareUtf16CodeUnits('\ufb33', '\ud83d\ude02') > 0)
  })

  it('orders by code unit, so uppercase precedes lowercase', () => {
    assert.ok(compareUtf16CodeUnits('B', 'a') < 0)
    assert.ok(compareUtf16CodeUnits('a', 'B') > 0)
  })

  it('orders the prefix before its extensions', () => {
    assert.ok(compareUtf16CodeUnits('ab', 'abc') < 0)
    assert.equal(compareUtf16CodeUnits('same', 'same'), 0)
  })
})

describe('isCanonicalJsonValue', () => {
  it('accepts data expressible in the RFC 8785 data model', () => {
    for (const good of [null, true, false, 0, -0, 1.5, 'text', { a: [1, { b: null }] }]) {
      assert.equal(isCanonicalJsonValue(good), true)
    }
  })

  it('rejects non-JSON and non-serializable values, deeply', () => {
    for (const bad of [
      undefined,
      NaN,
      Infinity,
      -Infinity,
      1n,
      Symbol('x'),
      () => 1,
      new Date(0),
      new Map(),
      '\uD800',
      [1, undefined],
      { a: { b: NaN } },
      { a: () => 1 },
    ]) {
      assert.equal(isCanonicalJsonValue(bad), false, String(bad))
    }
  })
})

import { describe, expect, test } from "bun:test";

import {
  isBoolean,
  isFunction,
  isNumber,
  isObject,
  isPromiseLike,
  isString,
} from "../src/internal/is";
import { isJsonArray, isJsonObject } from "../src/internal/json";

describe("internal/is", () => {
  test("isString", () => {
    expect(isString("a")).toBe(true);
    expect(isString("")).toBe(true);
    expect(isString(1)).toBe(false);
    expect(isString(null)).toBe(false);
  });

  test("isNumber", () => {
    expect(isNumber(0)).toBe(true);
    expect(isNumber(Number.NaN)).toBe(true);
    expect(isNumber("1")).toBe(false);
  });

  test("isBoolean", () => {
    expect(isBoolean(true)).toBe(true);
    expect(isBoolean(false)).toBe(true);
    expect(isBoolean(0)).toBe(false);
  });

  test("isFunction", () => {
    expect(isFunction(Math.max)).toBe(true);
    expect(isFunction(Map)).toBe(true);
    expect(isFunction({})).toBe(false);
  });

  test("isObject", () => {
    expect(isObject({})).toBe(true);
    expect(isObject([])).toBe(true);
    expect(isObject(null)).toBe(false);
    expect(isObject("x")).toBe(false);
    expect(isObject(Math.max)).toBe(false);
  });

  test("isPromiseLike", () => {
    expect(isPromiseLike(Promise.resolve())).toBe(true);
    expect(isPromiseLike(new Map([["then", 1]]))).toBe(false);
    expect(isPromiseLike({ catch: 1 })).toBe(false);
    expect(isPromiseLike(null)).toBe(false);
    expect(isPromiseLike(1)).toBe(false);
  });
});

describe("internal/json", () => {
  test("isJsonObject", () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject({ a: 1 })).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject("x")).toBe(false);
  });

  test("isJsonArray", () => {
    expect(isJsonArray([])).toBe(true);
    expect(isJsonArray([1, "a"])).toBe(true);
    expect(isJsonArray({})).toBe(false);
    expect(isJsonArray(null)).toBe(false);
  });
});

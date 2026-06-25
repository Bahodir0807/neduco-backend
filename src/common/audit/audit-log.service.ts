import { Injectable, Logger } from '@nestjs/common';
import { Types } from 'mongoose';

export type AuditActor = {
  id?: string;
  role?: string;
};

export type AuditTarget = {
  type: string;
  id?: string;
};

export type AuditEntry = {
  action: string;
  actor?: AuditActor;
  target?: AuditTarget;
  status?: 'success' | 'failure';
  metadata?: Record<string, unknown>;
  oldValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
};

const MONGO_INTERNAL_KEYS = new Set([
  '__v',
  'updatedAt',
  '_doc',
  '$__',
  '$isNew',
  'errors',
  '$locals',
  '$op',
  '$where',
]);

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

/**
 * Recursively normalize a value to plain JSON-safe primitives.
 * - Mongoose Document → calls .toObject() if method exists
 * - ObjectId → converts to string
 * - Date → converts to ISO string
 * - Nested objects → recurses
 * - Arrays → maps each element
 * - Primitives → returned as-is
 */
function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  // Mongoose document with toObject method
  if (isObject(value) && 'toObject' in value && typeof value.toObject === 'function') {
    return normalizeValue(value.toObject());
  }

  // Mongoose ObjectId
  if (value instanceof Types.ObjectId) {
    return value.toString();
  }

  // Date
  if (value instanceof Date) {
    return value.toISOString();
  }

  // Nested plain object (no toObject — recursed already for Mongoose docs)
  if (isObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (MONGO_INTERNAL_KEYS.has(k)) {
        continue;
      }
      result[k] = normalizeValue(v);
    }
    return result;
  }

  // Array
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }

  // Primitive (string, number, boolean)
  return value;
}

/**
 * Compare two normalized values for deep equality.
 * Handles ObjectId (via .toString()), Date (via .getTime()/toISOString), primitives, arrays, objects.
 */
function isEqual(a: unknown, b: unknown): boolean {
  // Same reference or both null/undefined
  if (a === b) {
    return true;
  }

  // One is null/undefined but the other is not
  if (a == null || b == null) {
    return false;
  }

  // ObjectId instances — compare via string
  if (a instanceof Types.ObjectId && b instanceof Types.ObjectId) {
    return a.toString() === b.toString();
  }

  // Date instances — compare via getTime()
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  // Array comparison
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!isEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }

  // Both are plain objects — recurse key-by-key
  if (isObject(a) && isObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) {
      return false;
    }
    for (const key of keysA) {
      if (!(key in b)) {
        return false;
      }
      if (!isEqual(a[key], b[key])) {
        return false;
      }
    }
    return true;
  }

  // Date as string (normalized) comparison
  if (typeof a === 'string' && typeof b === 'string') {
    const dateA = Date.parse(a);
    const dateB = Date.parse(b);
    if (!isNaN(dateA) && !isNaN(dateB)) {
      return dateA === dateB;
    }
  }

  // Fallback: strict equality (covers string, number, boolean)
  return a === b;
}

/**
 * Deep field-level diff between two raw inputs (documents, objects, etc.).
 *
 * - Mongoose Documents are automatically converted via .toObject() before comparison
 * - System fields (__v, updatedAt, _doc, $__, etc.) are excluded
 * - ObjectIds are compared by string value, not heap reference
 * - Dates are compared by timestamp (getTime()), not heap reference
 * - Arrays are compared element-by-element
 */
export function getFieldsDiff(
  oldObj: unknown,
  newObj: unknown,
): { oldValue: Record<string, unknown>; newValue: Record<string, unknown> } {
  const oldNormalized = normalizeValue(oldObj);
  const newNormalized = normalizeValue(newObj);

  const oldValue: Record<string, unknown> = {};
  const newValue: Record<string, unknown> = {};

  const oldMap = isObject(oldNormalized) ? oldNormalized : {};
  const newMap = isObject(newNormalized) ? newNormalized : {};

  const allKeys = new Set([
    ...Object.keys(oldMap),
    ...Object.keys(newMap),
  ]);

  for (const key of allKeys) {
    // Skip internal Mongo keys at the top level as well
    if (MONGO_INTERNAL_KEYS.has(key)) {
      continue;
    }

    const oldVal = oldMap[key];
    const newVal = newMap[key];

    if (isEqual(oldVal, newVal)) {
      continue;
    }

    // If both are normalized objects, recurse for nested diff
    if (isObject(oldVal) && isObject(newVal)) {
      const nested = getFieldsDiff(oldVal, newVal);
      if (Object.keys(nested.oldValue).length > 0) {
        oldValue[key] = nested.oldValue;
      }
      if (Object.keys(nested.newValue).length > 0) {
        newValue[key] = nested.newValue;
      }
      continue;
    }

    // Leaf change — store the normalized values (already primitives or arrays of primitives)
    oldValue[key] = oldVal;
    newValue[key] = newVal;
  }

  return { oldValue, newValue };
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger('Audit');

  log(entry: AuditEntry) {
    this.logger.log(JSON.stringify(this.sanitize(entry)));
  }

  logFailure(entry: AuditEntry) {
    this.logger.warn(
      JSON.stringify(this.sanitize({ ...entry, status: 'failure' })),
    );
  }

  private sanitize(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitize(item));
    }

    if (!isObject(value)) {
      return value;
    }

    const result: Record<string, unknown> = {};

    for (const [key, nestedValue] of Object.entries(value)) {
      if (['password', 'token', 'accessToken', 'refreshToken'].includes(key)) {
        continue;
      }

      result[key] = this.sanitize(nestedValue);
    }

    return result;
  }
}
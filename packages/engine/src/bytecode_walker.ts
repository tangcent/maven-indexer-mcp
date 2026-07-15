/**
 * Bytecode walker for extracting method-invocation edges from JVM `.class` files.
 *
 * Walks the `code` array of a method's `Code` attribute and extracts
 * `invokevirtual`, `invokespecial`, `invokestatic`, `invokeinterface`, and
 * `invokedynamic` instructions, resolving their constant-pool operands to
 * `(calleeClass, calleeMethod, calleeDescriptor)` tuples.
 *
 * Pure function: no I/O, no side effects. Unit-testable with synthetic buffers.
 *
 * Design notes (per Module 4 requirements):
 * - `invokedynamic` rarely resolves to a fixed callee at index time; the
 *   `NameAndType` name/descriptor are stored verbatim and `resolved = false`.
 * - Malformed / truncated buffers return partial edges + a warning rather than
 *   throwing, consistent with the indexer's robustness guarantees.
 */

export type InvokeKind = 'virtual' | 'special' | 'static' | 'interface' | 'dynamic';

export interface CallEdge {
    callerClass: string;
    callerMethod: string;
    callerDescriptor?: string;
    calleeClass: string;
    calleeMethod: string;
    calleeDescriptor?: string;
    invokeKind: InvokeKind;
    resolved: boolean;
}

// --- Opcode constants -------------------------------------------------------

const OP_TABLESWITCH = 0xaa;
const OP_LOOKUPSWITCH = 0xab;
const OP_WIDE = 0xc4;
const OP_IINC = 0x84;
const OP_INVOKEVIRTUAL = 0xb6;
const OP_INVOKESPECIAL = 0xb7;
const OP_INVOKESTATIC = 0xb8;
const OP_INVOKEINTERFACE = 0xb9;
const OP_INVOKEDYNAMIC = 0xba;

/**
 * Fixed instruction length (including the opcode byte) for every JVM opcode.
 * 0 = variable-length (`tableswitch`, `lookupswitch`, `wide`) — handled
 * specially in `walkInvokeEdges`. 0 also covers reserved/unknown opcodes,
 * which cause the walker to stop and return partial results.
 *
 * Source: JVMS §6.5 (Java SE 8 — class file major version 52).
 */
const OPCODE_LENGTH: Uint8Array = (() => {
    const t = new Uint8Array(256);
    const set = (start: number, end: number, len: number) => {
        for (let i = start; i <= end; i++) t[i] = len;
    };
    const one = (op: number) => { t[op] = 1; };
    const two = (op: number) => { t[op] = 2; };
    const three = (op: number) => { t[op] = 3; };
    const four = (op: number) => { t[op] = 4; };
    const five = (op: number) => { t[op] = 5; };

    set(0x00, 0x0f, 1);
    two(0x10); three(0x11); two(0x12); three(0x13); three(0x14);
    set(0x15, 0x19, 2);
    set(0x1a, 0x2d, 1);
    set(0x2e, 0x35, 1);
    set(0x36, 0x3a, 2);
    set(0x3b, 0x4e, 1);
    set(0x4f, 0x56, 1);
    set(0x57, 0x5f, 1);
    set(0x60, 0x77, 1);
    set(0x78, 0x83, 1);
    three(0x84); // iinc — 3 bytes (wide iinc is 6, handled in skipWide)
    set(0x85, 0x93, 1);
    set(0x94, 0x98, 1);
    set(0x99, 0xa6, 3);
    three(0xa7); three(0xa8); two(0xa9);
    // 0xaa tableswitch, 0xab lookupswitch — variable (0)
    set(0xac, 0xb1, 1);
    set(0xb2, 0xb5, 3);
    three(0xb6); three(0xb7); three(0xb8);
    five(0xb9);  // invokeinterface
    five(0xba);  // invokedynamic
    three(0xbb); two(0xbc); three(0xbd);
    one(0xbe); one(0xbf);
    three(0xc0); three(0xc1);
    one(0xc2); one(0xc3);
    // 0xc4 wide — variable (0)
    four(0xc5);
    three(0xc6); three(0xc7);
    five(0xc8); five(0xc9);
    one(0xca); one(0xfe); one(0xff);

    return t;
})();

// --- Constant-pool resolution helpers --------------------------------------

function cpUtf8(cp: any[], index: number): string | undefined {
    const e = cp[index];
    if (!e || e.tag !== 1) return undefined;
    return e.value as string;
}

function cpClassName(cp: any[], index: number): string | undefined {
    const e = cp[index];
    if (!e || e.tag !== 7) return undefined;
    return cpUtf8(cp, e.nameIndex);
}

interface NameAndType {
    name: string;
    descriptor: string;
}

function cpNameAndType(cp: any[], index: number): NameAndType | undefined {
    const e = cp[index];
    if (!e || e.tag !== 12) return undefined;
    const name = cpUtf8(cp, e.nameIndex);
    const descriptor = cpUtf8(cp, e.descriptorIndex);
    if (name === undefined || descriptor === undefined) return undefined;
    return { name, descriptor };
}

// --- Main walker ------------------------------------------------------------

export function walkInvokeEdges(
    code: Buffer,
    cp: any[],
    callerClass: string,
    callerMethod: string,
    callerDescriptor?: string,
): CallEdge[] {
    const edges: CallEdge[] = [];
    let pc = 0;

    while (pc < code.length) {
        const opcode = code.readUInt8(pc);
        const len = OPCODE_LENGTH[opcode];

        if (opcode === OP_TABLESWITCH) {
            pc = skipTableSwitch(code, pc);
            continue;
        }
        if (opcode === OP_LOOKUPSWITCH) {
            pc = skipLookupSwitch(code, pc);
            continue;
        }
        if (opcode === OP_WIDE) {
            pc = skipWide(code, pc);
            continue;
        }

        if (opcode === OP_INVOKEVIRTUAL || opcode === OP_INVOKESPECIAL || opcode === OP_INVOKESTATIC) {
            const cpIndex = safeReadU2(code, pc + 1);
            if (cpIndex === undefined) break;
            const edge = resolveMethodEdge(cp, cpIndex, callerClass, callerMethod, callerDescriptor,
                opcode === OP_INVOKEVIRTUAL ? 'virtual' : opcode === OP_INVOKESPECIAL ? 'special' : 'static');
            if (edge) edges.push(edge);
            pc += len;
            continue;
        }
        if (opcode === OP_INVOKEINTERFACE) {
            const cpIndex = safeReadU2(code, pc + 1);
            if (cpIndex === undefined) break;
            const edge = resolveMethodEdge(cp, cpIndex, callerClass, callerMethod, callerDescriptor, 'interface');
            if (edge) edges.push(edge);
            pc += len;
            continue;
        }
        if (opcode === OP_INVOKEDYNAMIC) {
            const cpIndex = safeReadU2(code, pc + 1);
            if (cpIndex === undefined) break;
            const edge = resolveInvokeDynamicEdge(cp, cpIndex, callerClass, callerMethod, callerDescriptor);
            if (edge) edges.push(edge);
            pc += len;
            continue;
        }

        if (len === 0) {
            console.error(`bytecode_walker: unknown opcode 0x${opcode.toString(16)} at pc=${pc} in ${callerClass}.${callerMethod}; returning ${edges.length} partial edges`);
            break;
        }

        if (pc + len > code.length) {
            console.error(`bytecode_walker: truncated instruction at pc=${pc} (need ${len} bytes, have ${code.length - pc}) in ${callerClass}.${callerMethod}; returning ${edges.length} partial edges`);
            break;
        }

        pc += len;
    }

    return edges;
}

function resolveMethodEdge(
    cp: any[],
    cpIndex: number,
    callerClass: string,
    callerMethod: string,
    callerDescriptor: string | undefined,
    invokeKind: InvokeKind,
): CallEdge | null {
    const entry = cp[cpIndex];
    if (!entry || (entry.tag !== 10 && entry.tag !== 11)) {
        return {
            callerClass, callerMethod, callerDescriptor,
            calleeClass: `cp#${cpIndex}`,
            calleeMethod: '',
            calleeDescriptor: undefined,
            invokeKind,
            resolved: false,
        };
    }
    const calleeClassRaw = cpClassName(cp, entry.classIndex);
    const nt = cpNameAndType(cp, entry.nameAndTypeIndex);
    if (!calleeClassRaw || !nt) {
        return {
            callerClass, callerMethod, callerDescriptor,
            calleeClass: calleeClassRaw ?? '',
            calleeMethod: nt?.name ?? '',
            calleeDescriptor: nt?.descriptor,
            invokeKind,
            resolved: false,
        };
    }
    return {
        callerClass, callerMethod, callerDescriptor,
        calleeClass: calleeClassRaw.replace(/\//g, '.'),
        calleeMethod: nt.name,
        calleeDescriptor: nt.descriptor,
        invokeKind,
        resolved: true,
    };
}

function resolveInvokeDynamicEdge(
    cp: any[],
    cpIndex: number,
    callerClass: string,
    callerMethod: string,
    callerDescriptor: string | undefined,
): CallEdge | null {
    const entry = cp[cpIndex];
    if (!entry || entry.tag !== 18) {
        return null;
    }
    const nt = cpNameAndType(cp, entry.nameAndTypeIndex);
    return {
        callerClass, callerMethod, callerDescriptor,
        calleeClass: '',
        calleeMethod: nt?.name ?? '',
        calleeDescriptor: nt?.descriptor,
        invokeKind: 'dynamic',
        resolved: false,
    };
}

// --- Variable-length opcode skippers ---------------------------------------

function safeReadU2(buf: Buffer, offset: number): number | undefined {
    if (offset + 2 > buf.length) return undefined;
    return buf.readUInt16BE(offset);
}

function skipTableSwitch(code: Buffer, pc: number): number {
    const base = pc + 1;
    const pad = (4 - (base % 4)) % 4;
    const defaultStart = base + pad;
    if (defaultStart + 12 > code.length) return code.length;
    const low = code.readInt32BE(defaultStart + 4);
    const high = code.readInt32BE(defaultStart + 8);
    const offsetsCount = high - low + 1;
    const end = defaultStart + 12 + offsetsCount * 4;
    return Math.min(end, code.length);
}

function skipLookupSwitch(code: Buffer, pc: number): number {
    const base = pc + 1;
    const pad = (4 - (base % 4)) % 4;
    const defaultStart = base + pad;
    if (defaultStart + 8 > code.length) return code.length;
    const npairs = code.readInt32BE(defaultStart + 4);
    const end = defaultStart + 8 + npairs * 8;
    return Math.min(end, code.length);
}

function skipWide(code: Buffer, pc: number): number {
    if (pc + 1 >= code.length) return code.length;
    const widened = code.readUInt8(pc + 1);
    return widened === OP_IINC ? 6 : 4;
}

import { describe, expect, it } from 'vitest';
import { walkInvokeEdges } from '@maven-indexer/engine';

/**
 * Regression tests for issue #22. `skipWide` used to return an instruction
 * *length* instead of the next instruction pointer, so every `wide` opcode
 * sent the walker backwards. The resulting loop appended call edges forever
 * until `refresh-index` exhausted the Node heap.
 */

const INVOKE_VIRTUAL = [0xb6, 0x00, 0x01]; // invokevirtual cp#1
const RETURN = 0xb1;

/** Constant pool with one resolvable Methodref at index 1. */
function methodCp(): any[] {
    const cp: any[] = [];
    cp[1] = { tag: 10, classIndex: 2, nameAndTypeIndex: 3 };
    cp[2] = { tag: 7, nameIndex: 4 };
    cp[3] = { tag: 12, nameIndex: 5, descriptorIndex: 6 };
    cp[4] = { tag: 1, value: 'java/io/PrintStream' };
    cp[5] = { tag: 1, value: 'println' };
    cp[6] = { tag: 1, value: '(I)V' };
    return cp;
}

function resolvedEdge() {
    return {
        calleeClass: 'java.io.PrintStream',
        calleeMethod: 'println',
        invokeKind: 'virtual',
        resolved: true,
    };
}

describe('walkInvokeEdges instruction pointer', () => {
    it('resolves an invoke with no variable-length instructions', () => {
        const code = Buffer.from([...INVOKE_VIRTUAL, RETURN]);
        const edges = walkInvokeEdges(code, methodCp(), 'demo/Plain', 'run');

        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject(resolvedEdge());
    });

    it('advances past a wide load and still walks the following invoke', () => {
        // The wide instruction sits at pc=4: the old code reset pc to 4 on
        // every iteration, so this method never progressed past the wide.
        const code = Buffer.from([
            0x00, 0x00, 0x00, 0x00,           // nops
            0xc4, 0x15, 0x01, 0x00,           // wide iload 256
            ...INVOKE_VIRTUAL,
            RETURN,
        ]);
        const edges = walkInvokeEdges(code, methodCp(), 'demo/WideLoad', 'run');

        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject(resolvedEdge());
    });

    it('advances past a wide iinc (6-byte form)', () => {
        const code = Buffer.from([
            ...Array(6).fill(0x00),           // nops, wide starts at pc=6
            0xc4, 0x84, 0x01, 0x00, 0x00, 0x05, // wide iinc 256, 5
            ...INVOKE_VIRTUAL,
            RETURN,
        ]);
        const edges = walkInvokeEdges(code, methodCp(), 'demo/WideIinc', 'run');

        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject(resolvedEdge());
    });

    it('stops on a truncated wide instruction instead of looping', () => {
        const code = Buffer.from([...INVOKE_VIRTUAL, 0xc4]);
        const edges = walkInvokeEdges(code, methodCp(), 'demo/TruncatedWide', 'run');

        expect(edges).toHaveLength(1);
    });

    it('skips a valid tableswitch and reaches the following invoke', () => {
        const code = Buffer.alloc(24);
        code[0] = 0xaa;                       // tableswitch, defaultStart = 4
        code.writeInt32BE(16, 4);             // default
        code.writeInt32BE(0, 8);              // low
        code.writeInt32BE(0, 12);             // high (one jump offset)
        code.writeInt32BE(16, 16);            // jump offset
        code.set(INVOKE_VIRTUAL, 20);
        code[23] = RETURN;

        const edges = walkInvokeEdges(code, methodCp(), 'demo/TableSwitch', 'run');

        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject(resolvedEdge());
    });

    it('stops on a tableswitch whose payload points backwards', () => {
        const code = Buffer.alloc(24);
        code[4] = 0xaa;                       // tableswitch at pc=4, defaultStart = 8
        code.writeInt32BE(20, 8);             // default
        code.writeInt32BE(0, 12);             // low
        code.writeInt32BE(-5, 16);            // high < low -> end == pc
        code.set(INVOKE_VIRTUAL, 20);
        code[23] = RETURN;

        const edges = walkInvokeEdges(code, methodCp(), 'demo/BadTableSwitch', 'run');

        expect(edges).toHaveLength(0);
    });

    it('stops on a lookupswitch with a negative npairs', () => {
        const code = Buffer.alloc(20);
        code[4] = 0xab;                       // lookupswitch at pc=4, defaultStart = 8
        code.writeInt32BE(16, 8);             // default
        code.writeInt32BE(-2, 12);            // npairs < 0 -> end before pc
        code.set(INVOKE_VIRTUAL, 16);
        code[19] = RETURN;

        const edges = walkInvokeEdges(code, methodCp(), 'demo/BadLookupSwitch', 'run');

        expect(edges).toHaveLength(0);
    });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../electron/main.js', import.meta.url), 'utf8');
const implementation = source.match(/function nativeTourBounds\(target, width, height\) \{[\s\S]*?\n\}/)[0];
function place(target, viewport, height = 280) {
  const context = { windowRef: { getContentBounds: () => viewport }, target, height };
  vm.createContext(context);
  vm.runInContext(`${implementation}; result = nativeTourBounds(target,470,height)`, context);
  return context.result;
}

test('tour above a bottom anchor does not cover the focused control', async () => {
  const result = place({left:20,top:530,width:200,height:40}, {width:900,height:600});
  assert.ok(result.y + result.height <= 530 - 14, 'card must end above target.top, not target.bottom');
});

for (const viewport of [{width:320,height:480}, {width:607,height:580}, {width:900,height:640}, {width:1440,height:900}]) {
  const {width, height} = viewport;
  const targets = [
    {left:16,top:16,width:100,height:36},
    {left:16,top:height-52,width:100,height:36},
    {left:16,top:height/2,width:44,height:36},
    {left:width-60,top:height/2,width:44,height:36},
    {left:width/2-50,top:height/2,width:100,height:36},
    {left:16,top:height/2,width:width-32,height:36}
  ];
  for (const [index, target] of targets.entries()) {
    for (const naturalHeight of [170, 430, 700]) {
      test(`viewport ${width}x${height}, anchor ${index}, height ${naturalHeight}: bounded and clear`, () => {
        const card = place(target, viewport, naturalHeight);
        assert.ok(card.x >= 8 && card.y >= 8);
        assert.ok(card.x + card.width <= width - 8 && card.y + card.height <= height - 8);
        assert.ok(card.width > 0 && card.height > 0);
        assert.ok(card.x + card.width <= target.left - 14 || card.x >= target.left + target.width + 14
          || card.y + card.height <= target.top - 14 || card.y >= target.top + target.height + 14);
      });
    }
  }
}

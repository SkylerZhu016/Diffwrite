import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fineChanges} from './changes.mjs';

test('marks only changed text and anchors removals to current offsets',()=>{
  assert.deepEqual(fineChanges('城门仍关着。','城门已开。'),{
    added:[[2,4]],removed:[{at:2,text:'仍关着'}]
  });
  assert.deepEqual(fineChanges('甲删乙。尾','甲乙。'),{
    added:[],removed:[{at:1,text:'删'},{at:3,text:'尾'}]
  });
  assert.deepEqual(fineChanges('甲乙','增甲乙末'),{added:[[0,1],[3,4]],removed:[]});
});
test('keeps user-perceived characters intact and handles long replacements',()=>{
  const old='甲👩🏽‍💻乙', current='甲👨🏻‍💻乙';
  const result=fineChanges(old,current);
  assert.equal(result.removed[0].text,'👩🏽‍💻');
  assert.equal(current.slice(...result.added[0]),'👨🏻‍💻');
  assert.deepEqual(fineChanges('前'+'甲'.repeat(850)+'后','前'+'乙'.repeat(900)+'后'),
    {added:[[1,901]],removed:[{at:1,text:'甲'.repeat(850)}]});
});

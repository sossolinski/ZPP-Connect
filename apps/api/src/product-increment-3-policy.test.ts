import { describe, expect, it } from 'vitest';
import { assertSupportJourneyResult } from '@zpp/shared';
import { safeJourneyReturn, withJourneyReturn } from '@zpp/shared';
describe('PI3 bounded journey navigation and truthful context',()=>{
 it('preserves supported queue filters and selected record',()=>{
  const value='/family-nok?q=Reported&status=Unverified&page=2&size=25&focus=record';
  expect(safeJourneyReturn(value)).toBe(value);
  expect(new URL(withJourneyReturn('/matching?claimId=claim',value),'https://test.local').searchParams.get('returnTo')).toBe(value);
 });
 it('rejects external, unsupported and nested return targets',()=>{
  for(const value of ['https://evil.test/','//evil.test/','/\\evil.test/','/users-access','/family-nok?unsupported=1','/matching?returnTo=%2Fdashboard','/dashboard#fragment'])expect(safeJourneyReturn(value)).toBeNull();
 });
 it('accepts explicit unavailability without inventing empty sources',()=>{
  expect(()=>assertSupportJourneyResult({status:'unavailable'})).not.toThrow();
  expect(()=>assertSupportJourneyResult({status:'available',value:{}})).toThrow();
 });
 it('rejects malformed lists and unsafe source navigation',()=>{
  const source={status:'available',value:{items:[],total:0,limit:6}};
  const value={loadedAt:new Date().toISOString(),reference:'Contact',incidentReference:'Incident',enquiries:source,families:source,passengers:source,matches:source,releases:source,followUp:source,activity:source,steps:[]};
  expect(()=>assertSupportJourneyResult({status:'available',value})).not.toThrow();
  expect(()=>assertSupportJourneyResult({status:'available',value:{...value,steps:[{key:'x',title:'x',state:'x',detail:'x',expectedRole:'x',href:'javascript:alert(1)'}]}})).toThrow();
  for(const limit of [NaN,Infinity,1.5])expect(()=>assertSupportJourneyResult({status:'available',value:{...value,families:{status:'available',value:{items:[],total:0,limit}}}})).toThrow();
  expect(()=>assertSupportJourneyResult({status:'available',value:{...value,families:{status:'available',value:{items:[],total:-1,limit:6}}}})).toThrow();
 });
});

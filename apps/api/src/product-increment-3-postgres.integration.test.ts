import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { assertSupportJourneyResult } from '@zpp/shared';
import { createSharedApp } from './test-support/listening-test-app.js';
import { prisma as runtimeDb } from './prisma.js';
const url=process.env.TEST_DATABASE_URL, db=url?new PrismaClient({datasources:{db:{url}}}):null,pg=url?describe:describe.skip;
pg('PI3 production PostgreSQL continuous support journey',()=>{
 const marker=`PI3-${randomUUID().slice(0,8)}`;let incidentId:string,otherId:string,adminOnlyId:string;
 const as=(email='coordinator@lot.pl')=>({'x-user-email':email});
 const post=async(path:string,body:Record<string,unknown>,email='coordinator@lot.pl')=>{const response=await request(createSharedApp()).post(`/api${path}`).set(as(email)).send({sessionId:incidentId,...body});expect(response.status,response.body.message??JSON.stringify(response.body)).toBeLessThan(300);return response.body;};
 const get=async(entity:string,id:string,email='coordinator@lot.pl',sessionId=incidentId)=>request(createSharedApp()).get('/api/support-journey').set(as(email)).query({sessionId,entity,id});
 const journey=async(entity:string,id:string,email='coordinator@lot.pl')=>{const response=await get(entity,id,email);expect(response.status).toBe(200);assertSupportJourneyResult(response.body);return response.body.value;};
 async function fixture(suffix:string){
  const passenger=await post('/passenger-records',{personType:'Passenger',firstName:'Reported',lastName:`${marker}-${suffix}`,flightNumber:'LO999',route:'XYZ-ABC',source:'Manual'});
  const enquiry=await post('/enquiries',{contactChannel:'Phone',callerName:'Synthetic Family Caller',callerPhone:'+48000000000',claimedRelationship:'Sibling',passengerRecordId:passenger.id,passengerFirstName:passenger.firstName,passengerLastName:passenger.lastName,passengerFlight:passenger.flightNumber,enquiryType:'Welfare concern',notes:'Reported need: transport'},'tec@lot.pl');
  const family=await post('/family-records',{caseId:enquiry.operationalId,firstName:'Synthetic',lastName:`Family-${suffix}`,claimedRelationship:'Sibling',passengerRecordId:passenger.id,passengerFirstName:passenger.firstName,passengerLastName:passenger.lastName,passengerFlight:passenger.flightNumber,immediateNeeds:'Protected welfare notes'});
  return {passenger,enquiry,family,claim:family.currentClaim};
 }
 async function verified(value:Awaited<ReturnType<typeof fixture>>){return post(`/family-records/${value.family.id}/verify`,{version:value.family.version,claimVersion:value.claim.version,basis:'Independent relationship evidence reviewed',verifiedRelationshipType:'Sibling'});}
 async function confirmed(value:Awaited<ReturnType<typeof fixture>>,claim=value.claim){return post(`/matching/claims/${claim.id}/confirm`,{passengerRecordId:value.passenger.id,expectedClaimVersion:claim.version,expectedPassengerVersion:value.passenger.version,reason:'Human independently reviewed candidate',operationId:randomUUID()});}
 beforeAll(async()=>{
  expect(createSharedApp().locals.productionComposition).toBe('postgres-explicit');
  incidentId=(await db!.session.create({data:{operationalId:`${marker}-INCIDENT`,mode:'REAL',status:'Draft',eventType:marker}})).id;
  otherId=(await db!.session.create({data:{operationalId:`${marker}-OTHER`,mode:'REAL',status:'Draft',eventType:marker}})).id;
  const users=await db!.user.findMany({where:{email:{in:['coordinator@lot.pl','tec@lot.pl','viewer@lot.pl','volunteer@lot.pl','admin@lot.pl']}}});
  await db!.incidentAssignment.createMany({data:users.map(user=>({incidentId,userId:user.id,function:'Synthetic journey acceptance'}))});
  adminOnlyId=(await db!.user.create({data:{email:`${marker.toLowerCase()}-admin@example.test`,displayName:'Admin only',roles:{create:{roleId:(await db!.role.findUniqueOrThrow({where:{normalizedName:'system-admin'}})).id,assignedBy:'PI3 acceptance'}}}})).id;
 });
 afterAll(async()=>{
  if(!db)return;
  await db.request.deleteMany({where:{incidentId:{in:[incidentId,otherId]}}});await db.releaseAction.deleteMany({where:{incidentId:{in:[incidentId,otherId]}}});await db.matchDecision.deleteMany({where:{incidentId:{in:[incidentId,otherId]}}});await db.matchingRecord.deleteMany({where:{sessionId:{in:[incidentId,otherId]}}});await db.matchSuggestion.deleteMany({where:{incidentId:{in:[incidentId,otherId]}}});await db.familyRecord.deleteMany({where:{sessionId:{in:[incidentId,otherId]}}});await db.enquiry.deleteMany({where:{sessionId:{in:[incidentId,otherId]}}});await db.passengerRecord.deleteMany({where:{sessionId:{in:[incidentId,otherId]}}});await db.session.deleteMany({where:{id:{in:[incidentId,otherId]}}});await db.user.delete({where:{id:adminOnlyId}});await db.$disconnect();
 });
 it('connects an enquiry shared reference without treating it as identity proof',async()=>{
  const value=await fixture('context'),data=await journey('enquiry',value.enquiry.id);
  expect(data.families.value.items.find((row:any)=>row.id===value.family.id).association).toBe('Shared reference');expect(data.passengers.value.items[0].id).toBe(value.passenger.id);expect(data.steps.some((row:any)=>row.title==='Relationship verification')).toBe(true);
 });
 it('TEC sees handover and family state while protected specialist sources stay unavailable',async()=>{
  const value=await fixture('tec');await post(`/enquiries/${value.enquiry.id}/send-to-family-assistance`,{version:value.enquiry.version},'tec@lot.pl');
  const data=await journey('enquiry',value.enquiry.id,'tec@lot.pl');expect(JSON.stringify(data.enquiries)).toContain('Sent to family assistance');expect(data.families.status).toBe('available');for(const key of ['passengers','matches','releases'])expect(data[key]).toEqual({status:'unavailable'});expect(JSON.stringify(data)).not.toContain('Protected welfare notes');
 });
 it('does not invent a contact, owner, or passenger from similar names',async()=>{
  const enquiry=await post('/enquiries',{contactChannel:'Phone',callerName:'Same name',passengerLastName:'Similar',enquiryType:'Information request'});
  const data=await journey('enquiry',enquiry.id);expect(data.families.value.total).toBe(0);expect(data.passengers.value.total).toBe(0);expect(data.followUp.value.total).toBe(0);expect(data.steps[0].state).toBe('Needs assignment');expect(data.steps[0].href).toBe(`/family-nok?fromEnquiry=${enquiry.id}`);
 });
 it('source confirmation remains independent from relationship verification',async()=>{
  const value=await fixture('source');await post(`/passenger-records/${value.passenger.id}/mark-src-confirmed`,{version:value.passenger.version,basis:'Reviewed manifest source'});
  const data=await journey('family',value.family.id);expect(JSON.stringify(data.passengers)).toContain('Source confirmed — not relationship verification');expect(JSON.stringify(data.families)).toContain('Unverified');
 });
 it('system suggestions do not become human decisions or release eligibility',async()=>{
  const value=await fixture('suggest');await post(`/matching/claims/${value.claim.id}/suggestions/generate`,{expectedClaimVersion:value.claim.version});
  const data=await journey('claim',value.claim.id);expect(JSON.stringify(data.matches)).toContain('SUGGESTED');expect(JSON.stringify(data.matches)).toContain('No current human decision');expect(data.steps.some((row:any)=>row.title==='Human match review')).toBe(true);
  const response=await request(createSharedApp()).post('/api/releases/prepare').set(as()).send({sessionId:incidentId,matchDecisionId:randomUUID(),actionType:'RELEASE',operationId:randomUUID()});expect(response.status).toBeGreaterThanOrEqual(400);
 });
 it('source correction exposes stale suggestion inputs in the compact journey',async()=>{
  const value=await fixture('stale-suggestion');await post(`/matching/claims/${value.claim.id}/suggestions/generate`,{expectedClaimVersion:value.claim.version});
  await post(`/passenger-records/${value.passenger.id}/correct-source`,{version:value.passenger.version,lastName:'Corrected source',reason:'Human reviewed corrected manifest'});
  const data=await journey('claim',value.claim.id);expect(JSON.stringify(data.matches)).toContain('Stale source or claim versions');expect(JSON.stringify(data.matches)).toContain('No current human decision');
 });
 it('a human-confirmed match still does not verify the reported relationship',async()=>{
  const value=await fixture('confirm-unverified');const match=await confirmed(value);const data=await journey('claim',value.claim.id);expect(JSON.stringify(data.matches)).toContain('CONFIRMED');expect(data.steps.some((row:any)=>row.title==='Relationship verification')).toBe(true);
  const response=await request(createSharedApp()).post('/api/releases/prepare').set(as()).send({sessionId:incidentId,matchDecisionId:match.currentDecision.id,actionType:'RELEASE',operationId:randomUUID()});expect(response.status).toBe(409);
 });
 it('explicit rejection preserves the separate reported claim state',async()=>{
  const value=await fixture('reject'),generated=await post(`/matching/claims/${value.claim.id}/suggestions/generate`,{expectedClaimVersion:value.claim.version}),suggestion=generated.data[0];
  await post(`/matching/claims/${value.claim.id}/reject`,{passengerRecordId:value.passenger.id,suggestionId:suggestion.id,reason:'Conflicting caller evidence reviewed',expectedClaimVersion:value.claim.version,expectedPassengerVersion:value.passenger.version,expectedSuggestionVersion:suggestion.version,operationId:randomUUID()});
  expect((await db!.relationshipClaim.findUniqueOrThrow({where:{id:value.claim.id}})).status).toBe('PENDING');expect(await db!.matchDecision.count({where:{relationshipClaimId:value.claim.id,decision:'REJECTED'}})).toBe(1);
 });
 it('correction preserves verification history and exposes stale human decisions',async()=>{
  const value=await fixture('correction'),family=await verified(value);await confirmed(value,family.currentClaim);
  const corrected=await post(`/family-records/${family.id}/correct-claim`,{version:family.version,claimVersion:family.currentClaim.version,passengerLastName:'Corrected reported surname',reason:'Caller corrected earlier report'});
  expect(corrected.currentClaim.id).not.toBe(family.currentClaim.id);expect(corrected.verificationStatus).not.toBe('Verified');expect(corrected.decisionHistory.length).toBeGreaterThan(0);expect(await db!.matchDecision.count({where:{relationshipClaimId:family.currentClaim.id,decision:'CONFIRMED'}})).toBe(1);
  const data=await journey('family',family.id);expect(JSON.stringify(data.families)).not.toContain('"value":"Verified"');expect(data.steps.some((row:any)=>row.title==='Human match review')).toBe(true);
 });
 it('upstream passenger correction makes release inputs and match stale without rewriting history',async()=>{
  const value=await fixture('stale'),family=await verified(value),match=await confirmed(value,family.currentClaim),release=await post('/releases/prepare',{matchDecisionId:match.currentDecision.id,actionType:'RELEASE',operationId:randomUUID()});
  await post(`/passenger-records/${value.passenger.id}/correct-source`,{version:value.passenger.version,lastName:'Corrected source surname',reason:'Manifest correction independently reviewed'});
  const data=await journey('release',release.id);expect(JSON.stringify(data.matches)).toContain('STALE');expect(JSON.stringify(data.releases)).toContain('REQUIRES_REVIEW');expect(data.steps.some((row:any)=>row.href===`/matching?claimId=${family.currentClaim.id}`)).toBe(true);expect((await db!.matchDecision.findUniqueOrThrow({where:{id:match.currentDecision.id}})).decision).toBe('CONFIRMED');
 });
 it('keeps an older selected release, its blockers and linked follow-up inside bounded history',async()=>{
  const value=await fixture('bounded-root'),family=await verified(value),match=await confirmed(value,family.currentClaim);
  const selected=await post('/releases/prepare',{matchDecisionId:match.currentDecision.id,actionType:'REUNIFICATION',operationId:randomUUID()});
  const followUp=await post('/requests',{category:'Transport',details:'Follow up the explicitly selected older release',relatedReleaseActionId:selected.id,operationId:randomUUID()});
  for(let index=0;index<7;index++){
   const newer=await post('/releases/prepare',{matchDecisionId:match.currentDecision.id,actionType:'RELEASE',operationId:randomUUID()});
   await post(`/releases/${newer.id}/cancel`,{expectedVersion:newer.version,reason:'Human cancelled unrelated preparation',operationId:randomUUID()});
  }
  const data=await journey('release',selected.id);expect(data.releases.value.items).toHaveLength(6);expect(data.releases.value.total).toBe(8);expect(data.releases.value.items[0].id).toBe(selected.id);
  expect(data.steps.some((row:any)=>row.key===`${selected.id}-identity`)).toBe(true);expect(data.steps.some((row:any)=>row.key===`${selected.id}-holdReview`)).toBe(true);expect(data.followUp.value.items.some((row:any)=>row.id===followUp.id)).toBe(true);
 });
 it('historical release resolves a replacement current claim after reported-claim correction',async()=>{
  const value=await fixture('release-claim-correction'),family=await verified(value),match=await confirmed(value,family.currentClaim),release=await post('/releases/prepare',{matchDecisionId:match.currentDecision.id,actionType:'RELEASE',operationId:randomUUID()});
  const corrected=await post(`/family-records/${family.id}/correct-claim`,{version:family.version,claimVersion:family.currentClaim.version,passengerLastName:'New reported facts',reason:'Human corrected reported facts'});
  const data=await journey('release',release.id);expect(data.matches.value.items[0].id).toBe(corrected.currentClaim.id);expect(data.steps.some((row:any)=>row.href===`/matching?claimId=${corrected.currentClaim.id}`)).toBe(true);expect(data.steps.some((row:any)=>row.href===`/matching?claimId=${family.currentClaim.id}`)).toBe(false);expect(data.releases.value.items[0].id).toBe(release.id);
 });
 it('release checks, authorization and completion remain distinct explicit commands',async()=>{
  const value=await fixture('release'),family=await verified(value),match=await confirmed(value,family.currentClaim),release=await post('/releases/prepare',{matchDecisionId:match.currentDecision.id,actionType:'REUNIFICATION',operationId:randomUUID()});
  const blocked=await journey('release',release.id);expect(blocked.steps.some((row:any)=>row.title==='Identity check')).toBe(true);expect(blocked.steps.some((row:any)=>row.title==='Hold review')).toBe(true);
  const identity=await post(`/releases/${release.id}/checks/identity`,{expectedVersion:release.version,result:'PASS',basis:'Independent identity evidence',operationId:randomUUID()}),hold=await post(`/releases/${release.id}/checks/hold`,{expectedVersion:identity.version,basis:'Reviewed current passenger hold',operationId:randomUUID()});
  expect(hold.status).toBe('PREPARED');const authorized=await post(`/releases/${release.id}/authorize`,{expectedVersion:hold.version,reason:'Human reviewed every current check',operationId:randomUUID()});expect(authorized.status).toBe('AUTHORIZED');const complete=await post(`/releases/${release.id}/complete`,{expectedVersion:authorized.version,reason:'Human completed physical handover',operationId:randomUUID()});expect(complete.status).toBe('COMPLETED');const data=await journey('release',release.id);expect(data.steps.some((row:any)=>row.key===`release-${release.id}`)).toBe(false);
 });
 it('claim-scoped release queues and candidates never substitute another case',async()=>{
  const value=await fixture('scope'),family=await verified(value),match=await confirmed(value,family.currentClaim),release=await post('/releases/prepare',{matchDecisionId:match.currentDecision.id,actionType:'RELEASE',operationId:randomUUID()});
  for(const path of ['queue','candidates']){const response=await request(createSharedApp()).get(`/api/releases/${path}`).set(as()).query({sessionId:incidentId,relationshipClaimId:family.currentClaim.id});expect(response.status).toBe(200);expect(response.body.data.length).toBe(1);expect(response.body.data[0].relationshipClaimId).toBe(family.currentClaim.id);}
  expect((await journey('release',release.id)).releases.value.items[0].id).toBe(release.id);
 });
 it('an active hold yields a permitted exact passenger resolution link',async()=>{
  const value=await fixture('hold'),family=await verified(value),match=await confirmed(value,family.currentClaim),release=await post('/releases/prepare',{matchDecisionId:match.currentDecision.id,actionType:'RELEASE',operationId:randomUUID()});
  await post(`/passenger-records/${value.passenger.id}/change-hold`,{version:value.passenger.version,holdStatus:'Legal hold',reason:'Hold requires authorized review'});
  const data=await journey('release',release.id);expect(data.steps.find((row:any)=>row.key.endsWith('-passengerHold')).href).toBe(`/passenger-src?focus=${value.passenger.id}`);
 });
 it('DENY hides source facts and links without false empty values',async()=>{
  const value=await fixture('deny'),user=await db!.user.findUniqueOrThrow({where:{email:'coordinator@lot.pl'}}),override=await db!.permissionOverride.create({data:{userId:user.id,permission:'passenger:read',effect:'DENY',reason:'PI3 source availability',createdById:user.id}});
  try{const data=await journey('enquiry',value.enquiry.id);expect(data.passengers).toEqual({status:'unavailable'});expect(data.steps.every((row:any)=>!row.href?.startsWith('/passenger-src'))).toBe(true);}finally{await db!.permissionOverride.delete({where:{id:override.id}});}
 });
 it('observer, member and admin-only cannot gain specialist access through context',async()=>{
  const value=await fixture('roles');for(const email of ['viewer@lot.pl','volunteer@lot.pl',`${marker.toLowerCase()}-admin@example.test`])expect((await get('enquiry',value.enquiry.id,email)).status).toBe(403);
 });
 it('incident isolation and missing context are enforced before composition',async()=>{
  const value=await fixture('isolation');expect((await get('enquiry',value.enquiry.id,'admin@lot.pl',otherId)).status).toBe(404);expect((await request(createSharedApp()).get('/api/support-journey').set(as()).query({entity:'enquiry',id:value.enquiry.id})).status).toBeGreaterThanOrEqual(400);
 });
 it('failed authoritative reads fail the context and retry without writing domain state',async()=>{
  const value=await fixture('failure'),before=await db!.familyRecord.findUniqueOrThrow({where:{id:value.family.id}}),spy=vi.spyOn(runtimeDb.familyRecord,'findMany').mockRejectedValueOnce(new Error('Source unavailable'));
  try{expect((await get('enquiry',value.enquiry.id)).status).toBe(500);}finally{spy.mockRestore();}await journey('enquiry',value.enquiry.id);expect(await db!.familyRecord.findUniqueOrThrow({where:{id:value.family.id}})).toEqual(before);
 });
});

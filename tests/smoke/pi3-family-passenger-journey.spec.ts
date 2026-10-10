import { test,expect,type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { login } from './helpers';
const db=new PrismaClient(),marker=`PI3-BROWSER-${randomUUID().slice(0,8)}`;
const apiUrl=process.env.PLAYWRIGHT_API_URL ?? `http://127.0.0.1:${process.env.PLAYWRIGHT_API_PORT??4100}/api`;
let incidentId:string,passenger:any,family:any,enquiry:any,claim:any,release:any;
const headers={'x-user-email':'coordinator@lot.pl'};
async function command(page:Page,path:string,data:any){const response=await page.request.post(`${apiUrl}${path}`,{headers,data:{sessionId:incidentId,...data}});expect(response.status(),await response.text()).toBeLessThan(300);return response.json();}
async function open(page:Page,path:string,email='coordinator@lot.pl'){
 await login(page,email);await expect(page.getByTestId('dashboard-freshness')).toContainText('Data loaded successfully');
 await page.evaluate(id=>localStorage.setItem('zpp:activeSessionId',id),incidentId);await page.goto(path);await expect(page.getByRole('button',{name:'Account menu'})).toBeVisible();
}
async function focused(page:Page,path:string){await page.goto(path);await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('dialog').getByTestId('support-journey')).toBeVisible();return page.getByRole('dialog');}
test.beforeAll(async({browser})=>{
 expect(process.env.PLAYWRIGHT_PERSISTENCE_MODE).toBe('postgres');
 incidentId=(await db.session.create({data:{operationalId:`${marker}-INCIDENT`,mode:'REAL',status:'Draft',eventType:'Synthetic continuous support journey'}})).id;
 const users=await db.user.findMany({where:{email:{in:['coordinator@lot.pl','tec@lot.pl','viewer@lot.pl']}}});await db.incidentAssignment.createMany({data:users.map(user=>({incidentId,userId:user.id,function:'Synthetic operator acceptance'}))});
 const page=await browser.newPage();
 try{
  // Existing manifest/source and unrelated negative examples are bootstrapped through real commands.
  passenger=await command(page,'/passenger-records',{personType:'Passenger',firstName:'Synthetic',lastName:marker,flightNumber:'LO999',route:'XYZ-ABC',source:'Manifest',manifestVersion:'PI3 synthetic manifest'});
  enquiry=await command(page,'/enquiries',{contactChannel:'Phone',callerName:'Synthetic Family Contact',passengerRecordId:passenger.id,passengerFirstName:passenger.firstName,passengerLastName:passenger.lastName,passengerFlight:passenger.flightNumber,enquiryType:'Welfare concern',notes:'Reported transport need'});
  family=await command(page,'/family-records',{caseId:enquiry.operationalId,firstName:'Synthetic',lastName:`Contact-${marker}`,claimedRelationship:'Sibling',passengerRecordId:passenger.id,passengerFirstName:passenger.firstName,passengerLastName:passenger.lastName,passengerFlight:passenger.flightNumber});claim=family.currentClaim;
  const verified=await command(page,`/family-records/${family.id}/verify`,{version:family.version,claimVersion:claim.version,basis:'Unrelated blocker fixture relationship evidence',verifiedRelationshipType:'Sibling'});
  const match=await command(page,`/matching/claims/${verified.currentClaim.id}/confirm`,{passengerRecordId:passenger.id,expectedClaimVersion:verified.currentClaim.version,expectedPassengerVersion:passenger.version,reason:'Unrelated blocker fixture human decision',operationId:randomUUID()});
  release=await command(page,'/releases/prepare',{matchDecisionId:match.currentDecision.id,actionType:'RELEASE',operationId:randomUUID()});family=verified;claim=verified.currentClaim;
 }finally{await page.close();}
});
test.afterAll(async()=>{await db.$disconnect();});

test('TEC enquiry → reviewed contact → source → human match → controlled reunification through the UI',async({page})=>{
 test.setTimeout(90_000); // Full multi-role journey includes every controlled human command.
 await open(page,'/tec-intake','tec@lot.pl');await page.getByRole('button',{name:'New enquiry',exact:true}).click();
 let drawer=page.getByRole('dialog');await drawer.getByLabel('Caller name').fill('Synthetic Operator Caller');await drawer.getByLabel('Caller phone / contact number').fill('+48000000111');await drawer.getByLabel('Claimed relationship').selectOption('Sibling');await drawer.getByLabel('Passenger first name').fill(passenger.firstName);await drawer.getByLabel('Passenger last name').fill(passenger.lastName);await drawer.getByLabel('Passenger flight').fill('LO999');await drawer.getByLabel('Enquiry type').selectOption('Welfare concern');await drawer.getByLabel('Notes',{exact:true}).fill('Reported need: transport and follow-up');
 const savedEnquiry=page.waitForResponse(response=>response.url().endsWith('/api/enquiries')&&response.request().method()==='POST');await drawer.getByRole('button',{name:'Save enquiry'}).click();const enquiryRecord=await(await savedEnquiry).json();
 await page.getByRole('button',{name:'Open saved record'}).click();drawer=page.getByRole('dialog');await drawer.getByRole('button',{name:'Send to ZPP'}).click();await expect(page.getByTestId('support-journey')).toContainText('Sent to family assistance');await expect(page.getByTestId('support-journey')).toContainText('Needs assignment');await expect(page.getByRole('link',{name:'Copy reported enquiry to new contact'})).toHaveCount(0);
 await open(page,`/tec-intake?focus=${enquiryRecord.id}`);drawer=page.getByRole('dialog');await drawer.getByRole('link',{name:'Copy reported enquiry to new contact'}).click();drawer=page.getByRole('dialog',{name:'New family contact'});
 await expect(drawer.getByLabel('Phone',{exact:true})).toHaveValue('+48000000111');await expect(drawer.getByLabel('Passenger last name')).toHaveValue(passenger.lastName);await expect(drawer).toContainText('no surname was guessed');await drawer.getByLabel(/^First name/).fill('Synthetic');await drawer.getByLabel(/^Last name/).fill('Operator Contact');await drawer.getByLabel('Known passenger').selectOption(passenger.id);
 const savedFamily=page.waitForResponse(response=>response.url().endsWith('/api/family-records')&&response.request().method()==='POST');await drawer.getByRole('button',{name:'Save family contact'}).click();const familyResponse=await savedFamily;expect(familyResponse.status(),await familyResponse.text()).toBe(201);const contact=await familyResponse.json();expect(contact.verificationStatus).toBe('Unverified');
 await page.getByRole('button',{name:'Open saved record'}).click();drawer=page.getByRole('dialog');await drawer.getByRole('button',{name:'Verify relationship',exact:true}).click();const verification=page.getByRole('dialog',{name:'Verify relationship claim'});await verification.getByLabel('Decision basis / evidence summary').fill('Human reviewed independent relationship evidence');await verification.getByRole('button',{name:'Verify relationship',exact:true}).click();await expect(verification).toHaveCount(0);
 // Exact source link, no manual module search.
 drawer=await focused(page,`/family-nok?focus=${contact.id}`);const panel=drawer.getByTestId('support-journey');await panel.getByRole('link',{name:new RegExp(`${passenger.operationalId}`)}).first().click();drawer=page.getByRole('dialog');await drawer.getByRole('button',{name:'Mark SRC confirmed'}).click();const sourceDialog=page.getByRole('dialog',{name:'Confirm SRC'});await sourceDialog.getByLabel('Decision basis',{exact:true}).fill('Human reviewed manifest source');await sourceDialog.getByRole('button',{name:'Apply decision'}).click();await expect(sourceDialog).toHaveCount(0);
 drawer=await focused(page,`/family-nok?focus=${contact.id}`);await drawer.getByRole('link',{name:'Continue: Human match review'}).click();await expect(page.getByRole('heading',{name:'Matching workspace'})).toBeVisible();await page.getByRole('button',{name:'Generate suggestions'}).click();await expect(page.getByText('System suggested — human review required')).toBeVisible();await page.getByRole('button',{name:'Confirm match',exact:true}).click();const matchDialog=page.getByRole('dialog',{name:'Confirm passenger match'});await matchDialog.getByLabel('Decision reason').fill('Human reviewed source, claim, signals and conflicts');await matchDialog.getByRole('button',{name:'Confirm match',exact:true}).click();await expect(page.getByText('Recorded human decision: CONFIRMED')).toBeVisible();
 await page.getByRole('link',{name:'Continue: Release preparation'}).click();await page.getByRole('button',{name:'Prepare action',exact:true}).click();let dialog=page.getByRole('dialog',{name:'Prepare release action'});await expect(dialog.getByRole('combobox', { name: /^Current human match/ }).locator('option')).toHaveCount(2);await dialog.getByRole('button',{name:'Prepare action',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(page.getByRole('button',{name:'Authorize',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Identity check',exact:true}).click();dialog=page.getByRole('dialog',{name:'Record identity check'});await dialog.getByLabel('Check basis').fill('Human checked contact identity evidence');await dialog.getByRole('button',{name:'Record identity check',exact:true}).click();await expect(dialog).toHaveCount(0);
 await page.getByRole('button',{name:'Review hold',exact:true}).click();dialog=page.getByRole('dialog',{name:'Record Passenger hold review'});await dialog.getByLabel('Check basis').fill('Human reviewed current passenger hold state');await dialog.getByRole('button',{name:'Record Passenger hold review',exact:true}).click();await expect(dialog).toHaveCount(0);
 await page.getByRole('button',{name:'Authorize',exact:true}).click();dialog=page.getByRole('dialog',{name:'AUTHORIZE REUNIFICATION'});await dialog.getByLabel('Human decision basis').fill('Human reviewed every current prerequisite');await dialog.getByRole('button',{name:'AUTHORIZE REUNIFICATION',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(page.getByRole('button',{name:'Complete',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Complete',exact:true}).click();dialog=page.getByRole('dialog',{name:'COMPLETE REUNIFICATION'});await dialog.getByLabel('Human decision basis').fill('Human completed physical reunification handover');await dialog.getByRole('button',{name:'COMPLETE REUNIFICATION',exact:true}).click();await expect(page.getByRole('button',{name:'Complete',exact:true})).toHaveCount(0);await expect(page.getByTestId('support-journey')).toContainText('COMPLETED');await page.goto('/dashboard');await expect(page.getByTestId('workspace-incident')).toContainText(marker);
});

test('missing human match explains prerequisites and links to the exact claim',async({page})=>{
 const contact=await command(page,'/family-records',{firstName:'Blocked',lastName:marker,claimedRelationship:'Parent',passengerFirstName:passenger.firstName,passengerLastName:passenger.lastName});
 await open(page,`/release-control?claimId=${contact.currentClaim.id}`);await expect(page.getByRole('button',{name:'Prepare action',exact:true})).toBeDisabled();await expect(page.getByTestId('support-journey')).toContainText('reported relationship has not been verified');await page.getByRole('link',{name:'Continue: Relationship verification'}).click();await expect(page.getByRole('dialog').getByLabel(/^Last name/)).toHaveValue(marker);await page.getByRole('dialog').getByRole('link',{name:'Return to previous work'}).click();await expect(page).toHaveURL(new RegExp(`claimId=${contact.currentClaim.id}`));
});
test('exact release focus explains missing checks and opens the source passenger',async({page})=>{
 await open(page,`/release-control?releaseId=${release.id}`);await expect(page.getByTestId('support-journey')).toContainText('No explicit identity check recorded');await expect(page.getByRole('button',{name:'Authorize',exact:true})).toBeDisabled();await page.getByTestId('support-journey').getByRole('link',{name:new RegExp(passenger.operationalId)}).first().click();await expect(page.getByRole('dialog').getByLabel(/^Last name/)).toHaveValue(marker);
});
test('TEC cannot use contact-copy or protected matching/release links',async({page})=>{
 await open(page,`/tec-intake?focus=${enquiry.id}`,'tec@lot.pl');await expect(page.getByRole('dialog').getByTestId('support-journey')).toContainText('Passenger / source: unavailable');await expect(page.getByRole('link',{name:'Copy reported enquiry to new contact'})).toHaveCount(0);await page.goto(`/matching?claimId=${claim.id}`);await expect(page.getByText('Access is restricted for the active operational profile.')).toBeVisible();
});
test('exact record focus preserves filtered queue and return path',async({page})=>{
 await open(page,`/family-nok?focus=${family.id}&q=NoSuchContact&status=Unverified&page=2&size=25`);let drawer=page.getByRole('dialog');await expect(drawer.getByLabel(/^Last name/)).toHaveValue(family.lastName);await drawer.getByTestId('support-journey').getByRole('link',{name:new RegExp(passenger.operationalId)}).first().click();drawer=page.getByRole('dialog');await drawer.getByRole('link',{name:'Return to previous work'}).click();await expect(page.getByLabel('Search records')).toHaveValue('NoSuchContact');await expect(page.getByLabel('Rows per page')).toHaveValue('25');await expect(page.getByRole('dialog').getByLabel(/^Last name/)).toHaveValue(family.lastName);
});
for(const kind of ['matching','release'] as const)test(`${kind} filtered queue and exact selection survive a keyboard return`,async({page})=>{
 const path=kind==='matching'?`/matching?claimId=${claim.id}&q=Absent&state=CONFIRMED&relationship=VERIFIED&offset=25`:`/release-control?releaseId=${release.id}&claimId=${claim.id}&q=Absent&status=PREPARED&eligibility=blocked&actionType=RELEASE&offset=25`;
 await open(page,path);const link=page.getByTestId('support-journey').getByRole('link',{name:new RegExp(passenger.operationalId)}).first();await link.focus();await link.press('Enter');const back=page.getByRole('dialog').getByRole('link',{name:'Return to previous work'});await back.focus();await back.press('Enter');
 await expect(page).toHaveURL(new RegExp(`offset=25`));for(const [key,value] of new URLSearchParams(path.split('?')[1]))expect(new URL(page.url()).searchParams.get(key)).toBe(value);
 if(kind==='matching'){await page.getByLabel('Search claims').fill('Updated search');await page.getByLabel('Search claims').press('Enter');}
 else {await page.getByLabel('Search release queue').fill('Updated search');await page.getByLabel('Search release queue').press('Enter');}
 await expect.poll(()=>new URL(page.url()).searchParams.get('q')).toBe('Updated search');expect(new URL(page.url()).searchParams.get('offset')).toBeNull();expect(new URL(page.url()).searchParams.get(kind==='matching'?'claimId':'releaseId')).toBe(kind==='matching'?claim.id:release.id);
});
test('verified relationship and system suggestions still cannot prepare release without a human decision',async({page})=>{
 const contact=await command(page,'/family-records',{firstName:'Suggested only',lastName:marker,claimedRelationship:'Sibling',passengerRecordId:passenger.id});const verified=await command(page,`/family-records/${contact.id}/verify`,{version:contact.version,claimVersion:contact.currentClaim.version,basis:'Human verified relationship independently',verifiedRelationshipType:'Sibling'});
 await command(page,`/matching/claims/${verified.currentClaim.id}/suggestions/generate`,{expectedClaimVersion:verified.currentClaim.version});await open(page,`/release-control?claimId=${verified.currentClaim.id}`);
 await expect(page.getByRole('button',{name:'Prepare action',exact:true})).toBeDisabled();await expect(page.getByTestId('support-journey')).toContainText('No current human-confirmed match');await page.getByRole('link',{name:'Continue: Human match review'}).click();await expect(page).toHaveURL(new RegExp(`claimId=${verified.currentClaim.id}`));await expect(page.getByText('System suggested — human review required').first()).toBeVisible();await expect(page.getByText('Recorded human decision: CONFIRMED')).toHaveCount(0);
});
test('corrected source makes old suggestion visibly stale and disables its confirmation',async({page})=>{
 const pax=await command(page,'/passenger-records',{personType:'Passenger',firstName:'Stale',lastName:marker,source:'Manual'}),contact=await command(page,'/family-records',{firstName:'Caller',lastName:marker,claimedRelationship:'Sibling',passengerRecordId:pax.id});await command(page,`/matching/claims/${contact.currentClaim.id}/suggestions/generate`,{expectedClaimVersion:contact.currentClaim.version});await command(page,`/passenger-records/${pax.id}/correct-source`,{version:pax.version,lastName:'Corrected source surname',reason:'Human corrected source record'});
 await open(page,`/matching?claimId=${contact.currentClaim.id}`);await expect(page.getByText('Stale suggestion — regenerate')).toBeVisible();await expect(page.getByRole('button',{name:'Confirm match',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Manual confirm'}).first()).toBeVisible();
});
test('failed contextual read is retryable and never invents empty source counts',async({page})=>{
 await open(page,`/family-nok?focus=${family.id}`);await expect(page.getByRole('dialog').getByTestId('support-journey')).toBeVisible();await page.route('**/api/support-journey?**',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"Source unavailable"}'}));await page.getByRole('dialog').getByRole('button',{name:'Refresh case context'}).click();await expect(page.getByRole('dialog')).toContainText('Case support context could not be loaded');await expect(page.getByTestId('support-journey')).toHaveCount(0);await page.unroute('**/api/support-journey?**');await page.getByRole('button',{name:'Retry case context'}).click();await expect(page.getByRole('dialog').getByTestId('support-journey')).toBeVisible();
});
test('keyboard opens a record, follows context and returns without losing selection',async({page})=>{
 await open(page,'/family-nok');await page.getByLabel('Search records').fill(family.operationalId);const row=page.getByRole('row').filter({hasText:family.operationalId});await row.focus();await row.press('Enter');await expect(page.getByRole('dialog')).toBeVisible();const link=page.getByRole('dialog').getByTestId('support-journey').getByRole('link',{name:new RegExp(passenger.operationalId)}).first();await link.focus();await link.press('Enter');const back=page.getByRole('dialog').getByRole('link',{name:'Return to previous work'});await back.focus();await back.press('Enter');await expect(page.getByRole('dialog').getByLabel(/^Last name/)).toHaveValue(family.lastName);
});
test('active passenger hold remains blocked and links to its exact source workflow',async({page})=>{
 const pax=await command(page,'/passenger-records',{personType:'Passenger',firstName:'Held',lastName:marker,source:'Manual'}),contact=await command(page,'/family-records',{firstName:'Held contact',lastName:marker,claimedRelationship:'Sibling',passengerRecordId:pax.id});
 const verified=await command(page,`/family-records/${contact.id}/verify`,{version:contact.version,claimVersion:contact.currentClaim.version,basis:'Human reviewed relationship',verifiedRelationshipType:'Sibling'});
 const match=await command(page,`/matching/claims/${verified.currentClaim.id}/confirm`,{passengerRecordId:pax.id,expectedClaimVersion:verified.currentClaim.version,expectedPassengerVersion:pax.version,reason:'Human reviewed match',operationId:randomUUID()});
 const action=await command(page,'/releases/prepare',{matchDecisionId:match.currentDecision.id,actionType:'RELEASE',operationId:randomUUID()});
 await command(page,`/passenger-records/${pax.id}/change-hold`,{version:pax.version,holdStatus:'Medical hold',reason:'Human recorded active hold'});
 await open(page,`/release-control?releaseId=${action.id}`);await expect(page.getByRole('button',{name:'Authorize',exact:true})).toBeDisabled();await expect(page.getByTestId('support-journey')).toContainText('Passenger hold');await page.getByRole('link',{name:'Continue: Passenger hold'}).click();await expect(page.getByRole('dialog').getByLabel(/^Last name/)).toHaveValue(marker);await expect(page.getByRole('dialog')).toContainText('Medical hold');
});

// Hold successful source reads and release them after the operator selects another record.
// These tests exercise response ordering, rather than only a refresh or network failure.
for(const kind of ['matching','release'] as const)test(`late ${kind} context cannot replace a newly selected record`,async({page})=>{
 const currentPassengerResponse=await page.request.get(`${apiUrl}/passenger-records/${passenger.id}?sessionId=${incidentId}`,{headers});expect(currentPassengerResponse.status()).toBe(200);const currentPassenger=await currentPassengerResponse.json();
 const contact=await command(page,'/family-records',{firstName:'Race',lastName:marker,claimedRelationship:'Sibling',passengerRecordId:passenger.id});
 const verified=await command(page,`/family-records/${contact.id}/verify`,{version:contact.version,claimVersion:contact.currentClaim.version,basis:'Unrelated race fixture verification',verifiedRelationshipType:'Sibling'});
 const decision=await command(page,`/matching/claims/${verified.currentClaim.id}/confirm`,{passengerRecordId:passenger.id,expectedClaimVersion:verified.currentClaim.version,expectedPassengerVersion:currentPassenger.version,reason:'Unrelated race fixture match',operationId:randomUUID()});
 const action=await command(page,'/releases/prepare',{matchDecisionId:decision.currentDecision.id,actionType:'RELEASE',operationId:randomUUID()});
 const oldId=kind==='matching'?claim.id:release.id,newId=kind==='matching'?verified.currentClaim.id:action.id;
 const source=kind==='matching'?`**/api/matching/claims/${oldId}?**`:`**/api/releases/${oldId}?**`;
 let releaseRead!:()=>void;const barrier=new Promise<void>(resolve=>{releaseRead=resolve;});let held=false;
 await page.route(source,async route=>{const response=await route.fetch();held=true;await barrier;await route.fulfill({response});});
 try{
  await open(page,kind==='matching'?`/matching?claimId=${oldId}`:`/release-control?releaseId=${oldId}`);
  await expect.poll(()=>held).toBe(true);
  const queue=page.getByRole('complementary',{name:'Matching claim queue'});
  if(kind==='matching')await queue.getByRole('button',{name:new RegExp(`Race ${marker}`)}).click();
  else await page.getByRole('button',{name:new RegExp(action.operationalId)}).click();
  await expect(page.getByTestId('support-journey')).toContainText(kind==='matching'?verified.operationalId:action.operationalId);
  releaseRead();await page.unrouteAll({behavior:'wait'});await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await expect(page).toHaveURL(new RegExp(`${kind==='matching'?'claimId':'releaseId'}=${newId}`));await expect(page.getByTestId('support-journey')).toContainText(kind==='matching'?verified.operationalId:action.operationalId);
 }finally{releaseRead();}
});

test('late record and support-journey responses cannot replace a newly opened family contact',async({page})=>{
 const other=await command(page,'/family-records',{firstName:'Race other',lastName:marker,claimedRelationship:'Sibling',passengerRecordId:passenger.id});
 await open(page,'/family-nok');
 let releaseRead!:()=>void;const barrier=new Promise<void>(resolve=>{releaseRead=resolve;});let held=false;
 await page.route(`**/api/family-records/${family.id}?**`,async route=>{const response=await route.fetch();held=true;await barrier;await route.fulfill({response});});
 await page.route('**/api/support-journey?**',async route=>{if(new URL(route.request().url()).searchParams.get('id')!==family.id)return route.continue();const response=await route.fetch();await barrier;await route.fulfill({response});});
 try{
  await page.getByRole('row').filter({hasText:family.operationalId}).getByRole('button',{name:'Edit record',exact:true}).click();await expect.poll(()=>held).toBe(true);await page.getByRole('dialog').press('Escape');
  await page.getByRole('row').filter({hasText:other.operationalId}).getByRole('button',{name:'Edit record',exact:true}).click();await expect(page.getByRole('dialog').getByTestId('support-journey')).toContainText(other.operationalId);
  releaseRead();await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));await expect(page.getByRole('dialog').getByLabel(/^First name/)).toHaveValue('Race other');await expect(page.getByRole('dialog').getByTestId('support-journey')).toContainText(other.operationalId);
 }finally{releaseRead();}
});

for(const width of [1440,1280,1024,768])test(`specialist context and decision pages remain usable at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:1000});await open(page,`/family-nok?focus=${family.id}`);await expect(page.getByRole('dialog').getByTestId('support-journey')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`storage/local-preview/pi3-contact-${width}.png`,fullPage:true});
 await page.goto(`/matching?claimId=${claim.id}`);await expect(page.getByTestId('support-journey')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`storage/local-preview/pi3-matching-${width}.png`,fullPage:true});
 await page.goto(`/release-control?releaseId=${release.id}`);await expect(page.getByTestId('support-journey')).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`storage/local-preview/pi3-release-${width}.png`,fullPage:true});
});

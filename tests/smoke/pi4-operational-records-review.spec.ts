import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { login } from "./helpers";

const db = new PrismaClient(), marker = "PI4-BROWSER-" + randomUUID().slice(0, 8);
const apiUrl = process.env.PLAYWRIGHT_API_URL ?? `http://127.0.0.1:${process.env.PLAYWRIGHT_API_PORT ?? 4100}/api`;
const headers = { "x-user-email": "coordinator@lot.pl" };
let activeId: string, closedId: string, closedCode: string, otherClosedId: string, versionId: string, evidenceId: string, revisionId: string, artifactId: string, generationId: string;
const evidenceBytes = Buffer.from(marker + " operational source\n");
async function post(page: Page, path: string, data: object, status = 200) {
  const r = await page.request.post(apiUrl + path, {headers, data}); expect(r.status(),await r.text()).toBe(status);return r.json();
}
async function get(page: Page, path: string) { const r=await page.request.get(apiUrl+path,{headers});expect(r.status()).toBe(200);return r.json(); }
async function ready(page: Page, email = "coordinator@lot.pl") {
  await login(page,email);await expect(page.getByTestId("dashboard-freshness")).toContainText("Data loaded successfully");
  await page.evaluate(id=>localStorage.setItem("zpp:activeSessionId",id),activeId);
  await page.goto("/dashboard");await expect(page.getByTestId("dashboard-freshness")).toContainText("Data loaded successfully");
}
async function openApproved(page: Page) {await ready(page);await page.goto(`/reports/after-action?incidentId=${closedId}&revisionId=${revisionId}&artifactId=${artifactId}`);await expect(page.getByTestId("approved-report")).toBeVisible();}

test.beforeAll(async({browser})=>{
  expect(process.env.PLAYWRIGHT_PERSISTENCE_MODE).toBe("postgres");
  const coordinator=await db.user.findUniqueOrThrow({where:{email:"coordinator@lot.pl"}});
  activeId=(await db.session.findUniqueOrThrow({where:{operationalId:"SES-2026-001"}})).id;
  const member=await db.memberProfile.findFirstOrThrow({where:{linkedUser:{email:"volunteer@lot.pl"}}});
  const closed=await db.session.create({data:{operationalId:marker+"-CLOSED",mode:"REAL",status:"Closed",eventType:"Reviewed incident",endAt:new Date("2026-09-01T12:00:00Z"),createdById:coordinator.id}});
  closedId=closed.id;closedCode=closed.operationalId;
  const other=await db.session.create({data:{operationalId:marker+"-OTHER",mode:"REAL",status:"Closed",eventType:"Other historical incident",createdById:coordinator.id}});otherClosedId=other.id;
  for(const id of [closedId,otherClosedId])await db.incidentAssignment.create({data:{incidentId:id,userId:coordinator.id,function:marker,createdById:coordinator.id}});
  const page=await browser.newPage();
  try {
    const d=await post(page,"/documents",{code:marker+"-GUIDE",title:marker+" required guidance",category:"Operational",ownerFunction:"ZPP"},201);
    const v=await post(page,`/documents/${d.id}/versions`,{versionLabel:"v1",contentMode:"Internal text",contentBody:"Read this controlled operational guidance."},201);
    const published=await post(page,`/document-versions/${v.id}/publish`,{expectedVersion:v.version,expectedCurrentPublishedVersionId:null,operationId:randomUUID()});versionId=published.id;
    await post(page,"/document-requirements",{documentVersionId:versionId,targetType:"MemberProfile",memberProfileId:member.id,acknowledgementRequired:true,effectiveFrom:"2019-01-01T00:00:00.000Z",dueAt:"2020-01-01T00:00:00.000Z"},201);
    const evidence=await page.request.post(`${apiUrl}/sessions/${activeId}/evidence`,{headers,multipart:{operationId:randomUUID(),category:"Operational evidence",description:marker+" source",file:{name:marker+".txt",mimeType:"text/plain",buffer:evidenceBytes}}});expect(evidence.status()).toBe(201);evidenceId=(await evidence.json()).id;
    const r=await post(page,"/after-action-reports",{sessionId:closedId,title:marker+" Post-Incident Report",operationId:randomUUID()},201);revisionId=r.reportVersionId;
    const edit=await page.request.patch(`${apiUrl}/after-action-report-versions/${revisionId}`,{headers,data:{expectedVersion:r.version,title:marker+" Post-Incident Report",eventDate:"2026-09-01T12:00:00.000Z",executiveSummary:"Reviewed summary for the historical incident.",findings:[{area:"Coordination",summary:"Handover roles were clear",detail:"Recorded explanation"}],lessons:[{statement:"Confirm ownership before handover"}],correctiveActions:[{recommendation:"Review the checklist",owner:"Coordinator",targetDate:"2026-12-01T00:00:00.000Z"}]}});expect(edit.status()).toBe(200);
    const review=await post(page,`/after-action-report-versions/${revisionId}/submit`,{expectedVersion:(await edit.json()).version,operationId:randomUUID()});
    const approved=await post(page,`/after-action-report-versions/${revisionId}/approve`,{expectedVersion:review.version,operationId:randomUUID()});
    artifactId=(await post(page,`/after-action-report-versions/${revisionId}/pdf-artifacts`,{expectedVersion:approved.version,operationId:randomUUID()},201)).artifactId;
    const exp=await page.request.post(`${apiUrl}/exports/passenger-register`,{headers,data:{sessionId:closedId,operationId:randomUUID()}});expect(exp.status()).toBe(200);generationId=exp.headers()["x-export-generation-id"]!;
  } finally {await page.close();}
});
test.afterAll(async()=>{await db.$disconnect();});

test("Workspace → exact required document → acknowledge → Evidence → return",async({page})=>{
  await ready(page,"volunteer@lot.pl");const activeBefore=await page.evaluate(()=>localStorage.getItem("zpp:activeSessionId"));
  const link=page.getByTestId("dashboard-attention").getByRole("link").filter({hasText:marker+" required guidance"});
  await expect(link).toHaveAttribute("href",new RegExp(`versionId=${versionId}`));await link.click();
  const dialog=page.getByRole("dialog");await expect(dialog).toContainText("Current published");await expect(dialog).toContainText("Read this controlled operational guidance.");
  await dialog.getByRole("button",{name:"Acknowledge",exact:true}).click();await expect(dialog).toHaveCount(0);
  const obligation=page.getByRole("heading",{name:marker+" required guidance"}).locator("..");await expect(obligation).toContainText("Acknowledged");await expect(obligation).toContainText("Required for me");
  await page.getByTestId("records-context").getByRole("link",{name:"Incident Evidence",exact:true}).click();
  const record=page.getByTestId("evidence-record").filter({hasText:marker+".txt"});await expect(record).toContainText("Uploaded");await expect(record).toContainText("Malware scan not configured");await expect(record.getByText(/SHA-256:/)).toBeHidden();
  const downloadEvent=page.waitForEvent("download");await record.getByRole("button",{name:/Download verified file/}).click();const download=await downloadEvent;
  expect(await readFile((await download.path())!)).toEqual(evidenceBytes);await expect(record).toContainText("Integrity verified for downloaded file");
  await page.getByRole("link",{name:"Return to previous view"}).click();await expect(page.getByRole("dialog")).toContainText("Current published");await page.getByRole("dialog").getByRole("button",{name:"Close",exact:true}).click();
  await page.getByRole("link",{name:/Return to current Incident Workspace/}).click();await expect(page.getByTestId("dashboard-freshness")).toContainText("Data loaded successfully");expect(await page.evaluate(()=>localStorage.getItem("zpp:activeSessionId"))).toBe(activeBefore);
});

test("closed incident register → approved report → exact retained PDF preserves global incident",async({page})=>{
  await ready(page);const globalBefore=await page.evaluate(()=>localStorage.getItem("zpp:activeSessionId"));await page.goto("/sessions");
  await page.getByRole("link",{name:`Post-Incident Report for ${closedCode}`,exact:true}).click();
  await expect(page.getByTestId("records-context")).toContainText("Historical incident");await expect(page.getByTestId("records-context")).toContainText(closedCode);await expect(page.getByTestId("records-context")).toContainText("Closed");
  const report=page.getByTestId("approved-report");await expect(report).toContainText("Reviewed summary");await expect(report).toContainText("ZPP Coordinator");await expect(report).toContainText("Handover roles were clear");await expect(report.locator("input,textarea")).toHaveCount(0);
  await page.getByRole("link",{name:"Link to this retained PDF",exact:true}).click();await expect(page).toHaveURL(new RegExp(`artifactId=${artifactId}`));
  const downloadEvent=page.waitForEvent("download");await page.getByRole("button",{name:/Download PDF /}).click();const download=await downloadEvent;
  const bytes=await readFile((await download.path())!);const artifact=await db.afterActionPdfArtifact.findUniqueOrThrow({where:{id:artifactId}});expect(bytes).toEqual(Buffer.from(artifact.content));expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.contentSha256);
  await expect(page.getByText("PDF integrity verified for downloaded artifact.")).toBeVisible();
  expect(await page.evaluate(()=>localStorage.getItem("zpp:activeSessionId"))).toBe(globalBefore);
  if(process.env.PI4_PDF_QA_PATH)await writeFile(process.env.PI4_PDF_QA_PATH,bytes);
});

test("permitted CSV export downloads current bytes and shows historical provenance",async({page})=>{
  await ready(page);await page.goto(`/reports?incidentId=${closedId}`);await expect(page.getByTestId("records-context")).toContainText(closedCode);
  await expect(page.getByText("PDF session summary",{exact:true})).toHaveCount(0);
  const event=page.waitForEvent("download");await page.getByRole("button",{name:"Export Passenger/Crew register",exact:true}).click();const download=await event;
  expect(download.suggestedFilename()).toContain("passenger-register.csv");const bytes=await readFile((await download.path())!);
  await expect(page.getByTestId("export-generation").first()).toContainText("ZPP Coordinator");await expect(page.getByTestId("export-generation").first()).toContainText("PassengerRecords");await expect(page.getByTestId("export-generation").first()).toContainText("CSV bytes are not retained");
  const generations=await db.exportGeneration.findMany({where:{incidentId:closedId},orderBy:{preparedAt:"desc"}});expect(createHash("sha256").update(bytes).digest("hex")).toBe(generations[0]!.contentSha256);
  await page.goto(`/reports?incidentId=${closedId}&generationId=${generationId}`);await expect(page.getByRole("heading",{name:"Selected export generation"})).toBeVisible();await expect(page.getByTestId("export-generation").first()).toContainText("Historical generation record");
  await expect(page.getByTestId("export-generation").first().getByRole("button",{name:/Download/})).toHaveCount(0);
});

test("observer receives restricted states and server rejects protected reads",async({page})=>{
  await ready(page,"viewer@lot.pl");for(const path of ["/evidence","/reports","/reports/after-action"]){await page.goto(path);await expect(page.getByText("Access is restricted for the active operational profile.")).toBeVisible();await expect(page.getByTestId("approved-report")).toHaveCount(0);}
  for(const path of [`/sessions/${activeId}/evidence`,`/sessions/${closedId}/export-generations`,`/after-action-reports?sessionId=${closedId}`]){const r=await page.request.get(apiUrl+path,{headers:{"x-user-email":"viewer@lot.pl"}});expect(r.status()).toBe(403);expect((await r.json()).data).toBeUndefined();}
  await page.goto("/documents");await expect(page.getByText("Outstanding in permitted library")).toBeVisible();await expect(page.getByRole("button",{name:"New document"})).toHaveCount(0);await expect(page.getByRole("button",{name:"Acknowledge",exact:true})).toHaveCount(0);
});

test("historical evidence is read-only and mismatched exact incident links fail",async({page})=>{
  await ready(page);await page.goto(`/evidence?incidentId=${closedId}`);await expect(page.getByTestId("records-context")).toContainText("read-only");await expect(page.getByRole("button",{name:"Upload retained evidence"})).toHaveCount(0);
  await page.goto(`/evidence?incidentId=${closedId}&evidenceId=${evidenceId}`);await expect(page.getByText(/Evidence unavailable:/)).toBeVisible();await expect(page.getByText(marker+" source",{exact:true})).toHaveCount(0);await expect(page.getByText(/No active evidence/)).toHaveCount(0);
  await page.goto(`/reports?incidentId=${otherClosedId}&generationId=${generationId}`);await expect(page.getByText(/selected export does not belong/)).toBeVisible();await expect(page.getByTestId("export-generation")).toHaveCount(0);
  await page.goto(`/reports/after-action?incidentId=${otherClosedId}&revisionId=${revisionId}`);await expect(page.getByText("Selected report revision or PDF unavailable.")).toBeVisible();await expect(page.getByTestId("approved-report")).toHaveCount(0);
});

test("failed sources remain unavailable rather than empty or zero",async({page})=>{
  await ready(page);
  for(const [route,path,empty] of [["**/api/sessions/*/evidence?**",`/evidence?incidentId=${activeId}`,"No active evidence"],["**/api/sessions/*/export-generations?**",`/reports?incidentId=${closedId}`,"No export generations are visible"]]){
    await page.route(route!,r=>r.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:"Controlled source unavailable"})}));await page.goto(path!);await expect(page.getByText(/Controlled source unavailable/)).toBeVisible();await expect(page.getByText(new RegExp(empty!))).toHaveCount(0);await page.unroute(route!);
  }
  await page.route("**/api/document-requirements?**",r=>r.fulfill({status:403,contentType:"application/json",body:JSON.stringify({error:"Requirements source restricted"})}));await page.goto("/documents");await expect(page.getByText("Requirements source restricted")).toBeVisible();await expect(page.getByText("No document requirements found")).toHaveCount(0);
});

test("blocks PDF download when byte digest differs from integrity header",async({page})=>{
  await openApproved(page);let downloads=0;page.on("download",()=>downloads++);
  await page.route(`**/api/after-action-pdf-artifacts/${artifactId}/download`,async r=>{const response=await r.fetch();await r.fulfill({response,headers:{...response.headers(),"x-content-sha256":"0".repeat(64)}});});
  await page.getByRole("button",{name:/Download PDF /}).click();await expect(page.getByText(/PDF integrity check failed/)).toBeVisible();expect(downloads).toBe(0);await expect(page.getByText("PDF integrity verified for downloaded artifact.")).toHaveCount(0);
});

for(const width of [1440,1280,1024,768])test(`records and historical report usable at ${width}px with keyboard`,async({page})=>{
  await page.setViewportSize({width,height:1000});await openApproved(page);
  for(const path of [`/reports/after-action?incidentId=${closedId}&revisionId=${revisionId}`,`/evidence?incidentId=${activeId}&evidenceId=${evidenceId}`,"/documents",`/reports?incidentId=${closedId}&generationId=${generationId}`]){
    await page.goto(path);await expect(page.getByTestId("records-context")).toBeVisible();
    if(path.startsWith("/reports/after"))await expect(page.getByTestId("approved-report")).toBeVisible();
    else if(path.startsWith("/evidence"))await expect(page.getByTestId("evidence-record").first()).toBeVisible();
    else if(path.startsWith("/documents"))await expect(page.getByRole("heading",{name:"Operational reference and managed documents"})).toBeVisible();
    else await expect(page.getByTestId("export-generation").first()).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const returnLink=page.getByRole("link",{name:/Return to current Incident Workspace/});await returnLink.focus();await expect(returnLink).toBeFocused();await page.keyboard.press("Enter");await expect(page).toHaveURL(/\/dashboard$/);
  }
});

test("exact Evidence and export generation open beyond the first list page",async({page})=>{
  test.setTimeout(60000);await ready(page);
  for(let i=0;i<51;i++){const r=await page.request.post(`${apiUrl}/sessions/${activeId}/evidence`,{headers,multipart:{operationId:randomUUID(),category:"Reference",file:{name:`later-${i}.txt`,mimeType:"text/plain",buffer:Buffer.from("Later source "+i)}}});expect(r.status()).toBe(201);}
  expect((await get(page,`/sessions/${activeId}/evidence?limit=50`)).data.some((r:any)=>r.id===evidenceId)).toBe(false);
  await page.goto(`/evidence?incidentId=${activeId}&evidenceId=${evidenceId}`);await expect(page.getByTestId("evidence-record").first()).toContainText(marker+".txt");
  for(let i=0;i<21;i++){const r=await page.request.post(`${apiUrl}/exports/passenger-register`,{headers,data:{sessionId:closedId,operationId:randomUUID()}});expect(r.status()).toBe(200);}
  expect((await get(page,`/sessions/${closedId}/export-generations?limit=20`)).data.some((r:any)=>r.id===generationId)).toBe(false);
  await page.goto(`/reports?incidentId=${closedId}&generationId=${generationId}`);await expect(page.getByTestId("export-generation").first()).toContainText("Historical generation record");await page.getByTestId("export-generation").first().locator("summary").click();await expect(page.getByTestId("export-generation").first()).toContainText(generationId);
});

test("late withdrawal reload cannot restore a selection left by browser Back",async({page})=>{
  await ready(page);
  const uploaded=await page.request.post(`${apiUrl}/sessions/${activeId}/evidence`,{headers,multipart:{operationId:randomUUID(),category:"Reference",file:{name:"late-withdrawal.txt",mimeType:"text/plain",buffer:Buffer.from("Late command source")}}});expect(uploaded.status()).toBe(201);const record=await uploaded.json();
  await page.goto(`/evidence?incidentId=${activeId}`);
  await page.getByRole("link",{name:"Link to evidence late-withdrawal.txt",exact:true}).click();await expect(page.getByRole("heading",{name:"Selected evidence",exact:true})).toBeVisible();
  let release!:()=>void, entered!:()=>void;
  const held=new Promise<void>(r=>release=r), seen=new Promise<void>(r=>entered=r);
  await page.route(`**/api/sessions/${activeId}/evidence/${record.id}/withdraw`,async route=>{const response=await route.fetch();entered();await held;await route.fulfill({response});});
  await page.getByTestId("evidence-record").first().getByRole("button",{name:"Withdraw late-withdrawal.txt",exact:true}).click();
  await page.getByLabel("Withdrawal reason").fill("Explicit replacement");await page.getByRole("button",{name:"Confirm withdrawal",exact:true}).click();await seen;
  await page.goBack();await expect(page).toHaveURL(new RegExp(`/evidence\\?incidentId=${activeId}$`));await expect(page.getByRole("heading",{name:"Selected evidence",exact:true})).toHaveCount(0);
  const delivered=page.waitForResponse(r=>r.url().endsWith(`/evidence/${record.id}/withdraw`));release();await delivered;
  await expect(page.getByLabel("Include withdrawn history")).toBeEnabled();await expect(page.getByRole("heading",{name:"Selected evidence",exact:true})).toHaveCount(0);await expect(page.getByRole("link",{name:"Link to evidence late-withdrawal.txt",exact:true})).toHaveCount(0);
});

test("late export reload cannot restore generation selection left by browser Back",async({page})=>{
  await ready(page);await page.goto(`/reports?incidentId=${closedId}`);
  const latest=(await get(page,`/sessions/${closedId}/export-generations?limit=1`)).data[0].id;
  await page.locator(`a[href='/reports?incidentId=${closedId}&generationId=${latest}']`).click();await expect(page.getByRole("heading",{name:"Selected export generation",exact:true})).toBeVisible();
  let release!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>release=r),seen=new Promise<void>(r=>entered=r);
  await page.route("**/api/exports/passenger-register",async route=>{const response=await route.fetch();entered();await held;await route.fulfill({response});});
  await page.getByRole("button",{name:"Export Passenger/Crew register",exact:true}).click();await seen;await page.goBack();await expect(page).toHaveURL(new RegExp(`/reports\\?incidentId=${closedId}$`));
  const downloaded=page.waitForEvent("download");release();await downloaded;await expect(page.getByRole("button",{name:"Export Passenger/Crew register",exact:true})).toBeEnabled();await expect(page.getByRole("heading",{name:"Selected export generation",exact:true})).toHaveCount(0);
});

test("revision read locks authoring until the selected revision finishes loading",async({page})=>{
  await openApproved(page);await page.getByRole("button",{name:"Create revision",exact:true}).click();await page.getByRole("dialog").getByRole("button",{name:"Create revision",exact:true}).click();await expect(page.getByLabel("Executive Summary")).toBeEnabled();
  let release!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>release=r),seen=new Promise<void>(r=>entered=r);
  await page.route(`**/api/after-action-report-versions/${revisionId}`,async route=>{const response=await route.fetch();entered();await held;await route.fulfill({response});});
  await page.getByRole("button",{name:"View revision 1",exact:true}).click();await seen;await expect(page.getByLabel("Executive Summary")).toBeDisabled();await expect(page.getByRole("button",{name:"View revision 2",exact:true})).toBeDisabled();release();await expect(page.getByTestId("approved-report")).toContainText("Reviewed summary");await expect(page.getByLabel("Executive Summary")).toHaveCount(0);
});

test("empty visible export history does not claim hidden generations do not exist",async({page})=>{
  const coordinator=await db.user.findUniqueOrThrow({where:{email:"coordinator@lot.pl"}}),email=marker.toLowerCase()+"-limited@example.invalid";
  const role=await db.role.create({data:{name:marker.toLowerCase()+"-limited-exports",displayName:"PI4 limited export reader",permissions:["session:read","reports:read","export:create","passenger:read"]}});
  const user=await db.user.create({data:{email,displayName:"PI4 limited export reader",status:"Active",roles:{create:{roleId:role.id,scopeType:"GLOBAL",assignedBy:marker}}}});
  const incident=await db.session.create({data:{operationalId:marker+"-FILTERED",mode:"REAL",status:"Draft",eventType:"Scoped exports",createdById:coordinator.id}});
  for(const id of [user.id,coordinator.id])await db.incidentAssignment.create({data:{incidentId:incident.id,userId:id,function:marker,createdById:coordinator.id}});
  const prepared=await page.request.post(`${apiUrl}/exports/family-register`,{headers,data:{sessionId:incident.id,operationId:randomUUID()}});expect(prepared.status()).toBe(200);
  await login(page,email);await page.goto(`/reports?incidentId=${incident.id}`);
  await expect(page.getByText("No export generations are visible for your current source permissions in this incident.",{exact:true})).toBeVisible();await expect(page.getByText("0 visible generation records",{exact:true})).toBeVisible();await expect(page.getByText("No exports have been generated for this incident.",{exact:true})).toHaveCount(0);
  const denied=await page.request.get(`${apiUrl}/exports/generations/${prepared.headers()["x-export-generation-id"]}`,{headers:{"x-user-email":email}});expect(denied.status()).toBe(404);expect((await denied.json()).data).toBeUndefined();
});

test("unavailable or freshly superseded document content cannot offer acknowledgement",async({page})=>{
  const member=await db.memberProfile.findFirstOrThrow({where:{linkedUser:{email:"volunteer@lot.pl"}}});
  const d=await post(page,"/documents",{code:marker+"-CONTENT",title:marker+" content availability",category:"Operational",ownerFunction:"ZPP"},201);
  const draft=await post(page,`/documents/${d.id}/versions`,{versionLabel:"v1",contentMode:"Internal text",contentBody:"Available guidance"},201);
  const version=await post(page,`/document-versions/${draft.id}/publish`,{expectedVersion:draft.version,operationId:randomUUID()});
  await post(page,"/document-requirements",{documentVersionId:version.id,targetType:"MemberProfile",memberProfileId:member.id,acknowledgementRequired:true,effectiveFrom:"2019-01-01T00:00:00.000Z",dueAt:"2020-01-01T00:00:00.000Z"},201);
  await ready(page,"volunteer@lot.pl");
  for(const content of [{status:"Published",contentAvailable:false,contentBody:""},{status:"Superseded",contentAvailable:true,contentBody:"Historical guidance"}]){
    await page.route(`**/api/document-versions/${version.id}/content`,async route=>{const response=await route.fetch();await route.fulfill({response,json:{...await response.json(),...content}});});
    await page.goto(`/documents?versionId=${version.id}`);const dialog=page.getByRole("dialog");await expect(dialog).toContainText(content.contentAvailable ? "Superseded — historical" : "Content is unavailable for this version.");await expect(dialog.getByRole("button",{name:"Acknowledge",exact:true})).toHaveCount(0);
    await page.unroute(`**/api/document-versions/${version.id}/content`);
  }
});

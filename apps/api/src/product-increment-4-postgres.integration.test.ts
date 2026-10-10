import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSharedApp } from "./test-support/listening-test-app.js";
import { safeJourneyReturn, withJourneyReturn } from "@zpp/shared";

const databaseUrl = process.env.TEST_DATABASE_URL;
const pg = databaseUrl ? describe : describe.skip;
const db = databaseUrl ? new PrismaClient({ datasources: { db: { url: databaseUrl } } }) : null;
pg("Product Increment 4 authorized operational records and historical review", () => {
  const marker = "PI4-" + randomUUID().slice(0, 8);
  const app = () => createSharedApp();
  const as = (email = "coordinator@lot.pl") => ({ "x-user-email": email });
  let coordinatorId: string, incidentId: string, otherIncidentId: string, memberId: string;
  const emails: Record<string, string> = {};
  const docPermissions = ["session:read", "document:read-own", "document:acknowledge-own"];
  async function actor(key: string, permissions: string[], linked = false, assigned = true) {
    const role = await db!.role.create({ data: { displayName: marker + " " + key, name: marker.toLowerCase() + "-" + key, description: marker, permissions } });
    const user = await db!.user.create({ data: { email: marker.toLowerCase() + "-" + key + "@example.invalid", displayName: marker + " " + key, status: "Active" } });
    await db!.userRole.create({ data: { userId: user.id, roleId: role.id, scopeType: "GLOBAL", assignedBy: marker } });
    if (assigned) for (const id of [incidentId, otherIncidentId]) await db!.incidentAssignment.create({ data: { incidentId: id, userId: user.id, function: marker, createdById: coordinatorId } });
    emails[key] = user.email;
    if (linked) {
      memberId = marker.toLowerCase() + "-member";
      await db!.memberProfile.create({ data: { id: memberId, memberId: marker + "-MEMBER", linkedUserId: user.id, firstName: "PI4", lastName: "Member", pool: "ZPP", role: "Member", assignedFunction: "Family Assistance", languages: ["PL"], createdById: coordinatorId, updatedById: coordinatorId } });
    }
  }
  async function get(path: string, email?: string) { return request(app()).get("/api" + path).set(as(email)); }
  async function post(path: string, body: object, email?: string, expected = 200) {
    const r = await request(app()).post("/api" + path).set(as(email)).send(body);
    expect(r.status, JSON.stringify(r.body)).toBe(expected); return r.body;
  }
  async function document(required = true) {
    const d = await post("/documents", {code: marker + "-" + randomUUID().slice(0,8), title: marker + " guidance", category: "Operational", ownerFunction: "ZPP"}, undefined, 201);
    const draft = await post(`/documents/${d.id}/versions`, {versionLabel: "v1",contentMode:"Internal text",contentBody:"Controlled current guidance"}, undefined, 201);
    const v = await post(`/document-versions/${draft.id}/publish`, {expectedVersion:draft.version,expectedCurrentPublishedVersionId:null,operationId:randomUUID()});
    await post("/document-requirements", {documentVersionId:v.id,targetType:"MemberProfile",memberProfileId:memberId,acknowledgementRequired:required,effectiveFrom:"2019-01-01T00:00:00.000Z",dueAt:"2020-01-01T00:00:00.000Z"}, undefined, 201);
    return {d,v};
  }
  async function obligation(id: string) {
    const r = await get(`/documents?mine=true&documentVersionId=${id}&limit=1`, emails.own); expect(r.status).toBe(200); return r.body;
  }
  async function evidence(id = incidentId) {
    const bytes = Buffer.from(marker + " retained incident source\n");
    const r = await request(app()).post(`/api/sessions/${id}/evidence`).set(as()).field("operationId", randomUUID()).field("category","Operational evidence").field("description", "Operational source description").attach("file",bytes,{filename:"source.txt",contentType:"text/plain"});
    expect(r.status, JSON.stringify(r.body)).toBe(201); return {record:r.body,bytes};
  }
  async function report() {
    const s = await db!.session.create({data:{operationalId:marker+"-CLOSED-"+randomUUID().slice(0,8),mode:"REAL",status:"Closed",eventType:"Historical incident",endAt:new Date("2026-09-01T12:00:00Z"),createdById:coordinatorId}});
    for(const email of ["coordinator@lot.pl", emails.reviewer, emails.approver]) {
      const u = await db!.user.findUniqueOrThrow({where:{email}});
      await db!.incidentAssignment.create({data:{incidentId:s.id,userId:u.id,function:marker,createdById:coordinatorId}});
    }
    const r = await post("/after-action-reports",{sessionId:s.id,title:marker+" review",operationId:randomUUID()},undefined,201);
    const edited = await request(app()).patch("/api/after-action-report-versions/"+r.reportVersionId).set(as()).send({expectedVersion:r.version,title:marker+" review",eventDate:"2026-09-01T12:00:00.000Z",executiveSummary:"Reviewed historical summary",findings:[{area:"Coordination",summary:"Handover finding",detail:"Recorded explanation"}],lessons:[{statement:"Clarify ownership"}],correctiveActions:[{recommendation:"Review guidance",owner:"Coordinator",targetDate:"2026-12-01T00:00:00.000Z"}]});
    expect(edited.status,JSON.stringify(edited.body)).toBe(200);return {s,r:edited.body};
  }
  async function approved() {
    const {s,r}=await report();const review=await post(`/after-action-report-versions/${r.reportVersionId}/submit`,{expectedVersion:r.version,operationId:randomUUID()},emails.reviewer);
    const approved=await post(`/after-action-report-versions/${r.reportVersionId}/approve`,{expectedVersion:review.version,operationId:randomUUID()},emails.approver);return {s,r:approved};
  }
  beforeAll(async()=>{
    await db!.$connect();coordinatorId=(await db!.user.findUniqueOrThrow({where:{email:"coordinator@lot.pl"}})).id;
    const s=await db!.session.create({data:{operationalId:marker+"-ACTIVE",mode:"REAL",status:"Draft",eventType:marker,createdById:coordinatorId}});incidentId=s.id;
    const other=await db!.session.create({data:{operationalId:marker+"-OTHER",mode:"REAL",status:"Draft",eventType:marker,createdById:coordinatorId}});otherIncidentId=other.id;
    for(const id of [s.id,other.id])await db!.incidentAssignment.create({data:{incidentId:id,userId:coordinatorId,function:marker,createdById:coordinatorId}});
    await actor("own",docPermissions,true);
    await actor("reader",["session:read","evidence:read"]);
    await actor("exports",["session:read","reports:read","export:create","passenger:read"]);
    await actor("reviewer",["session:read","aar:read","aar:review"]);
    await actor("approver",["session:read","aar:read","aar:approve"]);
    await actor("adminonly",["admin:manage"],false,false);
  });
  // Immutable report revisions/artifacts are retained in the disposable gate DB.
  afterAll(async()=>{await db?.$disconnect();});

  it("uses explicit PostgreSQL production composition",()=>{expect(app().locals.productionComposition).toBe("postgres-explicit");});
  it("projects required obligation with exact version, reason and overdue state",async()=>{const {v}=await document();const list=await obligation(v.id);expect(list.total).toBe(1);expect(list.data[0]).toMatchObject({documentVersionId:v.id,versionLabel:"v1",acknowledgementRequired:true,status:"Overdue",canAcknowledge:true,acknowledgedAt:null});expect(list.data[0].reasons[0].targetType).toBe("MemberProfile");});
  it("distinguishes reference awareness without acknowledgement required",async()=>{const {v}=await document(false);expect((await obligation(v.id)).data[0]).toMatchObject({acknowledgementRequired:false,status:"Awareness",canAcknowledge:false});});
  it("acknowledges only the exact current obligation and retains immutable history",async()=>{const {v}=await document();await post(`/document-versions/${v.id}/acknowledge`,{operationId:randomUUID()},emails.own,201);expect((await obligation(v.id)).data[0]).toMatchObject({status:"Acknowledged",canAcknowledge:false});const history=await get(`/document-acknowledgements?documentVersionId=${v.id}`,emails.own);expect(history.body.data[0].version.versionLabel).toBe("v1");expect(history.body.data[0].evidence.contentDigest).toBeTruthy();});
  it("supersedes guidance without satisfying a new requirement with old acknowledgement",async()=>{
    const {d,v}=await document();await post(`/document-versions/${v.id}/acknowledge`,{operationId:randomUUID()},emails.own,201);
    const draft=await post(`/documents/${d.id}/versions`,{versionLabel:"v2",contentMode:"Internal text",contentBody:"New current guidance"},undefined,201);
    const next=await post(`/document-versions/${draft.id}/publish`,{expectedVersion:draft.version,expectedCurrentPublishedVersionId:v.id,operationId:randomUUID()});
    await post("/document-requirements",{documentVersionId:next.id,targetType:"MemberProfile",memberProfileId:memberId,acknowledgementRequired:true,effectiveFrom:"2019-01-01T00:00:00.000Z",dueAt:"2020-01-01T00:00:00.000Z"},undefined,201);
    expect((await obligation(next.id)).data[0]).toMatchObject({versionLabel:"v2",status:"Overdue",acknowledgedAt:null});expect((await obligation(v.id)).total).toBe(0);
    const old=await get(`/document-versions/${v.id}/content`,emails.own);expect(old.status).toBe(200);expect(old.body.status).toBe("Superseded");
    const h=await get(`/document-acknowledgements?documentVersionId=${v.id}`,emails.own);expect(h.body.data[0].version.status).toBe("Superseded");
  });
  it("does not expose unassigned document versions to own-document readers",async()=>{const {v}=await document();const r=await get(`/document-versions/${v.id}/content`,emails.reader);expect(r.status).toBe(403);expect(r.body.contentBody).toBeUndefined();});
  it("returns operational evidence metadata with truthful scanning state",async()=>{const {record}=await evidence();const r=await get(`/sessions/${incidentId}/evidence/${record.id}`,emails.reader);expect(r.status).toBe(200);expect(r.body).toMatchObject({fileName:"source.txt",category:"Operational evidence",description:"Operational source description",status:"Active",scanStatus:"NOT_CONFIGURED"});expect(r.body.createdAt).toBeTruthy();expect(r.body.createdBy.displayName).toBeTruthy();expect(r.body.contentSha256).toMatch(/^[a-f0-9]{64}$/);expect(r.body.content).toBeUndefined();});
  it("automatically verifies retained evidence bytes and digest on download",async()=>{const {record,bytes}=await evidence();const r=await get(`/sessions/${incidentId}/evidence/${record.id}/download`,emails.reader);expect(r.status).toBe(200);expect(r.text).toBe(bytes.toString());expect(r.headers["x-content-sha256"]).toBe(createHash("sha256").update(bytes).digest("hex"));});
  it("withdrawal excludes active records and preserves history without download",async()=>{const {record}=await evidence();await post(`/sessions/${incidentId}/evidence/${record.id}/withdraw`,{expectedVersion:record.version,reason:"Replaced by authoritative source",operationId:randomUUID()});const active=await get(`/sessions/${incidentId}/evidence`);expect(active.body.data.some((r:any)=>r.id===record.id)).toBe(false);const history=await get(`/sessions/${incidentId}/evidence?includeWithdrawn=true`);expect(history.body.data.find((r:any)=>r.id===record.id).withdrawalReason).toBe("Replaced by authoritative source");expect((await get(`/sessions/${incidentId}/evidence/${record.id}/download`)).status).toBe(409);expect(await db!.storedFile.count({where:{id:record.id}})).toBe(1);});
  it("isolates exact evidence lookup across incidents",async()=>{const {record}=await evidence();expect((await get(`/sessions/${otherIncidentId}/evidence/${record.id}`,emails.reader)).status).toBe(404);});
  it("enforces evidence read versus upload and withdrawal separately",async()=>{const {record}=await evidence();const denied=await request(app()).post(`/api/sessions/${incidentId}/evidence`).set(as(emails.reader)).field("operationId",randomUUID()).field("category","Reference").attach("file",Buffer.from("x"),{filename:"x.txt",contentType:"text/plain"});expect(denied.status).toBe(403);expect((await request(app()).post(`/api/sessions/${incidentId}/evidence/${record.id}/withdraw`).set(as(emails.reader)).send({expectedVersion:record.version,reason:"Denied",operationId:randomUUID()})).status).toBe(403);});
  it("projects export actor, incident, generation time, scope and metadata-only provenance",async()=>{const r=await request(app()).post("/api/exports/passenger-register").set(as(emails.exports)).send({sessionId:incidentId,operationId:randomUUID()});expect(r.status).toBe(200);const id=r.headers["x-export-generation-id"];const detail=await get("/exports/generations/"+id,emails.exports);expect(detail.status).toBe(200);expect(detail.body.incident).toMatchObject({id:incidentId,status:"Draft",operationalId:marker+"-ACTIVE"});expect(detail.body.preparedBy.displayName).toBe(marker+" exports");expect(detail.body.includedSections).toEqual(["Session","PassengerRecords"]);expect(detail.body.preparedAt).toBeTruthy();expect(detail.body.content).toBeUndefined();expect(detail.body.contentSha256).toBe(createHash("sha256").update(r.text).digest("hex"));});
  it("keeps generation history incident-scoped and source-permission filtered",async()=>{await request(app()).post("/api/exports/family-register").set(as()).send({sessionId:incidentId,operationId:randomUUID()});const h=await get(`/sessions/${incidentId}/export-generations`,emails.exports);expect(h.status).toBe(200);expect(h.body.data.every((r:any)=>r.incidentId===incidentId&&r.exportType==="passenger-register")).toBe(true);expect((await get(`/sessions/${otherIncidentId}/export-generations`,emails.exports)).body.total).toBe(0);});
  it("retains historical generation metadata after incident closure",async()=>{const r=await request(app()).post("/api/exports/passenger-register").set(as()).send({sessionId:otherIncidentId,operationId:randomUUID()});expect(r.status).toBe(200);const before=await get("/exports/generations/"+r.headers["x-export-generation-id"]);await post(`/sessions/${otherIncidentId}/close`,{notes:"Reviewed incident closure"});const after=await get("/exports/generations/"+r.headers["x-export-generation-id"]);expect(after.body.incident.status).toBe("Closed");expect(after.body.contentSha256).toBe(before.body.contentSha256);expect(after.body.preparedAt).toBe(before.body.preparedAt);expect(after.body.incident.endAt).toBeTruthy();});
  it("rejects restricted export source and hides generation details",async()=>{const r=await request(app()).post("/api/exports/family-register").set(as(emails.exports)).send({sessionId:incidentId,operationId:randomUUID()});expect(r.status).toBe(403);const h=await get(`/sessions/${incidentId}/export-generations`);const family=h.body.data.find((g:any)=>g.exportType==="family-register");expect((await get("/exports/generations/"+family.id,emails.exports)).status).toBe(404);});
  it("shows Draft, review and approval capabilities for distinct roles",async()=>{const {r}=await report();const draft=await get(`/after-action-report-versions/${r.reportVersionId}`);expect(draft.body.status).toBe("Draft");expect(draft.body.capabilities.edit).toBe(true);const review=await post(`/after-action-report-versions/${r.reportVersionId}/submit`,{expectedVersion:r.version,operationId:randomUUID()},emails.reviewer);const under=await get(`/after-action-report-versions/${r.reportVersionId}`,emails.approver);expect(under.body.status).toBe("Under review");expect(under.body.capabilities).toMatchObject({edit:false,approve:true});const denied=await request(app()).post(`/api/after-action-report-versions/${r.reportVersionId}/approve`).set(as(emails.reviewer)).send({expectedVersion:review.version,operationId:randomUUID()});expect(denied.status).toBe(404);});
  it("projects approved snapshot actor and historical context without changing active incident",async()=>{const {s,r}=await approved();const v=(await get(`/after-action-report-versions/${r.reportVersionId}`)).body;expect(v.status).toBe("Approved");expect(v.contextSnapshot.approver).toBe(marker+" approver");expect(v.approvedAt).toBeTruthy();expect(v.report.session).toMatchObject({id:s.id,status:"Closed",operationalId:s.operationalId,endAt:"2026-09-01T12:00:00.000Z"});expect((await db!.session.findUniqueOrThrow({where:{id:incidentId}})).status).toBe("Draft");});
  it("approved content is immutable and later changes create a separate revision",async()=>{const {r}=await approved();const v=(await get(`/after-action-report-versions/${r.reportVersionId}`)).body;const patch=await request(app()).patch(`/api/after-action-report-versions/${v.id}`).set(as()).send({expectedVersion:v.version,title:"Changed"});expect(patch.status).toBeGreaterThanOrEqual(400);await expect(db!.afterActionReportVersion.update({where:{id:v.id},data:{executiveSummary:"tamper"}})).rejects.toThrow();const next=await post(`/after-action-reports/${v.reportId}/revisions`,{expectedVersion:v.report.version,operationId:randomUUID()},undefined,201);const old=(await get(`/after-action-report-versions/${v.id}`)).body;expect(old.contentSha256).toBe(v.contentSha256);expect((await get(`/after-action-report-versions/${next.reportVersionId}`)).body).toMatchObject({revision:2,status:"Draft",executiveSummary:v.executiveSummary});});
  it("retains an exact approved PDF with incident/revision provenance and matching digest",async()=>{const {r}=await approved();const artifact=await post(`/after-action-report-versions/${r.reportVersionId}/pdf-artifacts`,{expectedVersion:r.version,operationId:randomUUID()},undefined,201);const m=(await get(`/after-action-pdf-artifacts/${artifact.artifactId}`)).body;expect(m.reportVersionId).toBe(r.reportVersionId);expect(m.rendererVersion).toBe("aar-pdf-v1");expect(m.generatedBy.displayName).toBeTruthy();const download=await get(`/after-action-pdf-artifacts/${artifact.artifactId}/download`);expect(download.status).toBe(200);expect(createHash("sha256").update(download.body).digest("hex")).toBe(m.contentSha256);expect(Buffer.from(download.body).subarray(0,5).toString()).toBe("%PDF-");});
  it("denies observer and admin-only operational records without leaking content",async()=>{for(const email of ["viewer@lot.pl",emails.adminonly]){for(const path of [`/sessions/${incidentId}/evidence`,`/sessions/${incidentId}/export-generations`,`/after-action-reports?sessionId=${incidentId}`]){const r=await get(path,email);expect(r.status).toBe(403);expect(r.body.data).toBeUndefined();}}});
});

describe("PI4 bounded record return routes",()=>{
  it.each(["/documents?versionId=dver-123","/evidence?incidentId=abc&evidenceId=def","/reports?incidentId=abc&generationId=def","/reports/after-action?incidentId=abc&revisionId=def&artifactId=ghi","/sessions?focus=abc"])("permits supported exact context %s",route=>{expect(safeJourneyReturn(route)).toBe(route);expect(withJourneyReturn("/documents",route)).toContain("returnTo=");});
  it.each(["https://evil.example/","//evil.example/","/documents?returnTo=%2Fdashboard","/reports?unsupported=true","/evidence?evidenceId="+"x".repeat(201),"/reports/after-action#fragment"])("rejects unsafe or unsupported context %s",route=>{expect(safeJourneyReturn(route)).toBeNull();});
});

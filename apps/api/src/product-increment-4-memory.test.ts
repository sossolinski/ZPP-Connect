import request from "supertest";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "./test-support/listening-test-app.js";

describe("PI4 memory preview document projection compatibility",()=>{
  it("identifies required guidance and opens its exact personal version",async()=>{
    const app=createApp();
    const own=await request(app).get("/api/documents?mine=true").set("x-user-email","volunteer@lot.pl");
    expect(own.status).toBe(200);const required=own.body.data.find((row:any)=>row.code==="ERP-ROLE-CARDS");expect(required.acknowledgementRequired).toBe(true);
    const exact=await request(app).get("/api/documents").query({mine:true,documentVersionId:required.documentVersionId,limit:1}).set("x-user-email","volunteer@lot.pl");expect(exact.body.total).toBe(1);expect(exact.body.data[0].documentVersionId).toBe(required.documentVersionId);
  });
  it("shows awareness references without inventing an acknowledgement obligation",async()=>{
    const app=createApp(), headers={"x-user-email":"admin@lot.pl"};
    const d=await request(app).post("/api/documents").set(headers).send({code:"PI4-REF-"+randomUUID().slice(0,8),title:"Operational reference",category:"Operational",ownerFunction:"ZPP"});expect(d.status).toBe(201);
    const draft=await request(app).post(`/api/documents/${d.body.id}/versions`).set(headers).send({versionLabel:"v1",contentMode:"Internal text",contentBody:"Reference guidance"});expect(draft.status).toBe(201);
    const published=await request(app).post(`/api/document-versions/${draft.body.id}/publish`).set(headers).send({expectedVersion:draft.body.version,operationId:randomUUID()});expect(published.status).toBe(200);
    const requirement=await request(app).post("/api/document-requirements").set(headers).send({documentVersionId:published.body.id,targetType:"Role",targetRole:"ZPP Member",acknowledgementRequired:false});expect(requirement.status).toBe(201);
    const own=await request(app).get("/api/documents").query({mine:true,documentVersionId:published.body.id}).set("x-user-email","volunteer@lot.pl");expect(own.status).toBe(200);expect(own.body.data[0]).toMatchObject({acknowledgementRequired:false,status:"Awareness",canAcknowledge:false,dueAt:null});expect(own.body.totals).toMatchObject({required:0,outstanding:0,awareness:1});
  });
});

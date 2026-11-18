// Synthetic data only. Not a production data store or security boundary.
import { DatabaseSync } from "node:sqlite";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
function conflict(){return Object.assign(new Error("SNAPSHOT_VERSION_CONFLICT"),{status:409});}
export class SyntheticSqliteSnapshotRepository {
  #db;
  constructor(path){
    if(path!==":memory:"){
      path=resolve(path);
      const parent=dirname(path);
      mkdirSync(parent,{recursive:true,mode:0o700});
      if(realpathSync(parent)!==parent||lstatSync(parent).isSymbolicLink()||(lstatSync(parent).mode&0o077)!==0)throw Error("A private local directory is required");
      try{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)!==0)throw Error("Unsafe snapshot path");}catch(e){if(e.code!=="ENOENT")throw e;}
    }
    this.#db=new DatabaseSync(path);
    if(path!==":memory:")chmodSync(path,0o600);
    this.#db.exec("PRAGMA busy_timeout=2000; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; CREATE TABLE IF NOT EXISTS scope_snapshot(tenant TEXT NOT NULL, facility TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0), payload TEXT NOT NULL, PRIMARY KEY(tenant,facility)) STRICT;");
  }
  load(tenant,facility){
    const r=this.#db.prepare("SELECT version,payload FROM scope_snapshot WHERE tenant=? AND facility=?").get(tenant,facility);
    return r?{version:r.version,payload:r.payload}:null;
  }
  save(tenant,facility,expected,payload){
    if(!Number.isSafeInteger(expected)||expected<0||typeof payload!=="string"||Buffer.byteLength(payload,"utf8")>16*1024*1024)throw Error("Invalid snapshot");
    const r=expected===0
      ?this.#db.prepare("INSERT INTO scope_snapshot(tenant,facility,version,payload) VALUES(?,?,1,?) ON CONFLICT(tenant,facility) DO NOTHING").run(tenant,facility,payload)
      :this.#db.prepare("UPDATE scope_snapshot SET version=version+1,payload=? WHERE tenant=? AND facility=? AND version=?").run(payload,tenant,facility,expected);
    if(Number(r.changes)!==1)throw conflict();
    return expected+1;
  }
  close(){this.#db.close();}
}

const {test,afterEach,mock}=require('node:test');
const assert=require('node:assert/strict');
const Group=require('../src/modules/groups/Group');
const Member=require('../src/modules/groups/GroupMember');
const Expense=require('../src/modules/expenses/Expense');
const Bill=require('../src/modules/bills/Bill');
const Settlement=require('../src/modules/settlements/Settlement');
const L=require('../src/modules/groups/group.lifecycle');
const {groupAccess}=require('../src/modules/groups/groupAccess.middleware');
const controller=require('../src/modules/groups/group.controller');
const a='507f1f77bcf86cd799439011',g='507f1f77bcf86cd799439012';
const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});
const query=value=>({setOptions(){return this;},select(){return this;},sort(){return this;},populate(){return this;},then(resolve,reject){return Promise.resolve(value).then(resolve,reject);}});
afterEach(()=>{mock.restoreAll();mock.timers.reset();});
function fixture(){
 const group={_id:g,name:'Trip',ownerId:a,deletedAt:null,currency:'PHP'};
 const request=()=>({params:{id:g},user:{_id:a},group});
 mock.method(Group,'findById',()=>query(group));mock.method(Member,'findOne',async()=>({}));
 mock.method(Group,'findOneAndUpdate',(_filter,update)=>{Object.assign(group,update.$set);return Promise.resolve(group);});
 const paused=[];mock.method(Expense,'updateMany',async(filter,update)=>paused.push({filter,update}));
 for(const Model of [Expense,Bill,Member,Settlement])mock.method(Model,'deleteMany',()=>assert.fail('soft lifecycle must retain all child records'));
 mock.method(Group,'findByIdAndDelete',()=>assert.fail('soft lifecycle must retain group'));
 mock.method(Bill,'find',()=>query([]));
 return {group,request,paused};
}
test('soft delete and restore preserve child records and original memberships',async()=>{
 const f=fixture();let res=response();await L.softDeleteGroup(f.request(),res);assert.equal(res.statusCode,200);assert.ok(f.group.deletedAt instanceof Date);assert.equal(f.group.deletedBy,a);assert.equal(f.paused.length,1);
 res=response();await L.restoreGroup(f.request(),res);assert.equal(res.statusCode,200);assert.equal(f.group.deletedAt,null);assert.equal(f.group.deletedBy,null);assert.equal(f.paused.length,2);
});
test('deleted group access and direct expense or bill access return 404',async()=>{
 const f=fixture();f.group.deletedAt=new Date();let res=response();await groupAccess(f.request(),res,()=>assert.fail('must not access deleted group'));assert.equal(res.statusCode,404);
 for(const Model of [Expense,Bill]){mock.method(Model,'findById',()=>query({groupId:g}));res=response();await L.activeRecordGroup(Model,'id')(f.request(),res,()=>assert.fail('must block child route'));assert.equal(res.statusCode,404);}
 f.group.deletedAt=null;let next=false;await L.activeRecordGroup(Expense,'id')(f.request(),response(),()=>{next=true;});assert.equal(next,true);
});
test('lifecycle actions require an active owner and deleted group listing is owner-scoped',async()=>{
 const f=fixture();const request=f.request();request.user._id='other';let res=response();await L.ownerIncludingDeleted(request,res,()=>assert.fail('nonowner must be denied'));assert.equal(res.statusCode,403);
 mock.method(Member,'findOne',async()=>null);res=response();await L.ownerIncludingDeleted(f.request(),res,()=>assert.fail('inactive owner must be denied'));assert.equal(res.statusCode,403);
 f.group.deletedAt=new Date();mock.method(Group,'find',filter=>{assert.equal(filter.ownerId,a);assert.deepEqual(filter.deletedAt,{$ne:null});return query([f.group]);});res=response();await L.deletedGroups(f.request(),res);assert.equal(res.statusCode,200);assert.equal(res.body.data.groups[0].id,g);
});
test('normal group lists hide soft-deleted references but retain active ones',async()=>{
 fixture();mock.method(Member,'find',()=>query([{groupId:{_id:g,name:'Deleted',deletedAt:new Date()}},{groupId:{_id:a,name:'Active'},role:'OWNER'}]));
 const res=response();await controller.getMyGroups({user:{_id:a}},res);assert.deepEqual(res.body.data.groups.map(group=>group.name),['Active']);
});
test('restoration skips missed recurring bill dates and leaves recurring expense sources paused',async()=>{
 const f=fixture();f.group.deletedAt=new Date();mock.timers.enable({apis:['Date'],now:new Date('2026-10-23T12:00:00Z')});
 const source={_id:'bill',dueDate:new Date('2026-01-31'),recurrence:'MONTHLY',generatedThrough:0};mock.method(Bill,'find',()=>query([source]));
 mock.method(Bill,'updateOne',async(filter,update)=>{assert.equal(filter._id,'bill');assert.equal(update.$max.generatedThrough,8);});
 const res=response();await L.restoreGroup(f.request(),res);assert.equal(res.statusCode,200);assert.equal(f.paused[0].update.$set['recurring.paused'],true);
});
test('model reads default to active records and trusted restore can opt in without passing driver flags',async()=>{
 assert.equal(new Group().deletedAt,null);
 for(const operation of ['find','findOne','countDocuments','findOneAndUpdate','findOneAndDelete']){
  const q=Group.find({_id:g});await Group.schema.s.hooks.execPre(operation,q,[]);assert.equal(q.getFilter().deletedAt,null);
  const all=Group.find({deletedAt:{$ne:null}}).setOptions({withDeleted:true});await Group.schema.s.hooks.execPre(operation,all,[]);assert.deepEqual(all.getFilter().deletedAt,{$ne:null});assert.equal(all.getOptions().withDeleted,undefined);
 }
});

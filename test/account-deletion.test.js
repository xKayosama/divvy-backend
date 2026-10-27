const { test, mock, afterEach }=require('node:test');
const assert=require('node:assert/strict');
const bcrypt=require('bcryptjs');
const User=require('../src/modules/users/User');
const Group=require('../src/modules/groups/Group');
const Member=require('../src/modules/groups/GroupMember');
const Device=require('../src/modules/notifications/PushDevice');
const Inbox=require('../src/modules/notifications/InboxNotification');
const deletion=require('../src/modules/auth/account-deletion');
const user={_id:'111111111111111111111111',email:'private@example.com',password:'hash',authVersion:0};
const query=value=>({select(){return this;},populate(){return this;},sort(){return this;},limit(){return this;},setOptions(){return this;},then(resolve,reject){return Promise.resolve(value).then(resolve,reject);}});
const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});
afterEach(()=>mock.restoreAll());
test('ownership preview includes hidden groups and chooses the oldest living active member',async()=>{
 mock.method(Group,'find',filter=>{assert.deepEqual(filter,{ownerId:user._id});return query([{_id:'group',name:'Shared',deletedAt:null}]);});
 mock.method(Member,'find',filter=>{assert.equal(filter.status,'ACTIVE');assert.equal(filter.userId.$ne,user._id);return query([{userId:null},{userId:{_id:'deleted',deletedAt:new Date()}},{userId:{_id:'next',firstName:'Next',lastName:'Owner'}}]);});
 const plan=await deletion.ownershipPlan(user._id);assert.equal(plan[0].action,'TRANSFER');assert.equal(plan[0].successor.id,'next');
 assert.notEqual(deletion.planHash(plan),deletion.planHash([]));
});
test('solo ownership preview explicitly lists permanent group deletion',async()=>{
 mock.method(Group,'find',()=>query([{_id:'solo',name:'Solo',deletedAt:new Date()}]));mock.method(Member,'find',()=>query([]));
 const res=response();await deletion.preview({user},res);assert.equal(res.body.data.groups[0].action,'DELETE');assert.equal(res.body.data.groups[0].deleted,true);assert.match(res.body.data.planHash,/^[a-f0-9]{64}$/);
});
test('deletion requires password, typed confirmation and reviewed plan',async()=>{
 for(const body of [{},{password:'pass',confirmation:'delete',planHash:'a'.repeat(64)},{password:'',confirmation:'DELETE',planHash:'a'.repeat(64)},{password:'pass',confirmation:'DELETE',planHash:[]}]){
  const res=response();await deletion.remove({user,body},res);assert.equal(res.statusCode,400);
 }
});
test('wrong passwords or changed previews never mutate the account',async()=>{
 mock.method(User,'findOne',()=>query(user));mock.method(bcrypt,'compare',async()=>false);let res=response();
 const body={password:'password',confirmation:'DELETE',planHash:'a'.repeat(64)};
 await deletion.remove({user,body},res);assert.equal(res.statusCode,400);
 mock.method(bcrypt,'compare',async()=>true);mock.method(Group,'find',()=>query([]));res=response();
 await deletion.remove({user,body},res);assert.equal(res.statusCode,409);
});
test('deletion removes login identity and revokes all sessions in a single write; cleanup failure is recoverable',async()=>{
 mock.method(User,'findOne',()=>query(user));mock.method(bcrypt,'compare',async()=>true);mock.method(Group,'find',()=>query([]));mock.method(console,'error',()=>{});
 mock.method(User,'findOneAndUpdate',(filter,update)=>{
  assert.equal(filter.password,user.password);assert.equal(filter.deletedAt,null);
  assert.equal(update.$set.firstName,'Deleted');assert.notEqual(update.$set.email,user.email);assert.equal(update.$set.avatar,null);
  assert.equal(update.$inc.authVersion,1);assert.deepEqual(update.$unset,{passwordReset:1,emailChange:1});
  assert.equal(update.$set.deletion.email,user.email);assert.notEqual(update.$set.password,user.password);return query({...user,deletedAt:new Date()});
 });
 mock.method(Member,'updateMany',async()=>{throw Error('offline');});
 const res=response();await deletion.remove({user,body:{password:'password',confirmation:'DELETE',planHash:deletion.planHash([])}},res);assert.equal(res.statusCode,200);
});
test('cleanup retains financial references but removes private data, subscriptions and its completed job',async()=>{
 mock.method(User,'findOne',()=>query({...user,deletedAt:new Date(),deletion:{email:user.email}}));mock.method(Group,'find',()=>query([]));
 let membershipCalls=0;mock.method(Member,'updateMany',async(filter,update)=>{
  membershipCalls++;if(membershipCalls===1)assert.deepEqual(update,{$set:{status:'INACTIVE',role:'MEMBER',accountDeleted:true}});
  else {assert.equal(filter.$or[1]['invitation.email'],user.email);assert.deepEqual(update,{$unset:{invitation:1}});}
 });
 for(const model of [Device,Inbox])mock.method(model,'deleteMany',async filter=>assert.deepEqual(filter,{userId:user._id}));
 mock.method(User,'updateOne',async(filter,update)=>{assert.equal(filter._id,user._id);assert.deepEqual(update,{$unset:{deletion:1}});});
 await deletion.cleanup(user._id);assert.equal(membershipCalls,2);
});
test('cleanup only finalizes after required operations succeed',async()=>{
 mock.method(User,'findOne',()=>query({...user,deletedAt:new Date(),deletion:{email:user.email}}));mock.method(Member,'updateMany',async()=>({}));
 mock.method(Device,'deleteMany',async()=>{throw Error('offline');});mock.method(User,'updateOne',async()=>assert.fail('must retain pending cleanup'));
 await assert.rejects(deletion.cleanup(user._id),/offline/);
});
test('already completed cleanup is idempotent and never touches unrelated data',async()=>{
 mock.method(User,'findOne',filter=>{assert.equal(filter._id,user._id);assert.deepEqual(filter.deletion,{$exists:true});return query(null);});
 mock.method(Member,'updateMany',()=>assert.fail('no cleanup expected'));await deletion.cleanup(user._id);
});

test('shared cleanup promotes the successor and restores groups temporarily hidden for a solo purge',async()=>{
 mock.method(User,'findOne',()=>query({...user,deletedAt:new Date(),deletion:{email:user.email}}));
 mock.method(User,'exists',async()=>true);mock.method(User,'updateOne',async()=>({}));
 for(const model of [Device,Inbox])mock.method(model,'deleteMany',async()=>({}));
 mock.method(Member,'updateMany',async()=>({}));
 let scans=0;mock.method(Group,'find',()=>query(scans++===0?[{_id:'shared',name:'Shared'}]:[]));
 mock.method(Member,'find',()=>query([{userId:{_id:'successor',firstName:'Next',lastName:'Owner'}}]));
 mock.method(Member,'updateOne',async(filter,update)=>{assert.equal(filter.userId,'successor');assert.equal(filter.status,'ACTIVE');assert.equal(update.$set.role,'OWNER');return {matchedCount:1};});
 mock.method(Group,'findById',()=>query({accountDeletion:{originalDeletedAt:null}}));
 mock.method(Group,'findOneAndUpdate',(filter,update)=>{assert.equal(filter.ownerId,user._id);assert.equal(update.$set.ownerId,'successor');assert.equal(update.$set.deletedAt,null);assert.deepEqual(update.$unset,{accountDeletion:1});return query({_id:'shared'});});
 await deletion.cleanup(user._id);
});

test('solo groups are hidden with a durable grace period before any child records are purged',async()=>{
 mock.method(User,'findOne',()=>query({...user,deletedAt:new Date(),deletion:{email:user.email}}));
 mock.method(Member,'updateMany',async()=>({}));
 for(const model of [Device,Inbox])mock.method(model,'deleteMany',async()=>({}));
 mock.method(Group,'find',()=>query([{_id:'solo',name:'Solo'}]));mock.method(Member,'find',()=>query([]));
 mock.method(Group,'findById',()=>query({_id:'solo',ownerId:user._id,deletedAt:null}));
 mock.method(Group,'findOneAndUpdate',(filter,update)=>{
  assert.equal(filter.ownerId,user._id);assert.deepEqual(filter.accountDeletion,{$exists:false});
  assert.ok(update.$set.accountDeletion.purgeAfter.getTime()>Date.now()+89000);
  return query({_id:'solo',ownerId:user._id,accountDeletion:update.$set.accountDeletion});
 });
 mock.method(require('../src/modules/bills/Bill'),'deleteMany',()=>assert.fail('must drain existing workers first'));
 mock.method(User,'updateOne',()=>assert.fail('must keep cleanup job until purge'));
 await assert.rejects(deletion.cleanup(user._id),/OWNERSHIP_CHANGED/);
});

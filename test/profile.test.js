const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../src/modules/users/User');
const Revoked = require('../src/modules/auth/RevokedToken');
const delivery = require('../src/modules/auth/password-reset.email');
const profile = require('../src/modules/auth/profile.controller');
const { protect } = require('../src/modules/auth/auth.middleware');
process.env.JWT_SECRET = 'profile-test-secret-at-least-thirty-two-bytes';
const user = { _id: '111111111111111111111111', firstName: 'Old', lastName: 'Name', email: 'old@example.com', password: 'hash', authVersion: 0, role: 'USER' };
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const query = value => ({ select() { return this; }, then(resolve,reject) { return Promise.resolve(value).then(resolve,reject); } });
const request = body => ({ user: { ...user }, body });
afterEach(() => mock.restoreAll());
function setupRequest() {
 mock.method(User,'findOne',() => query({...user})); mock.method(bcrypt,'compare',async()=>true);
 mock.method(User,'exists',async()=>null);mock.method(delivery,'isConfigured',()=>true);
}
test('profile rejects blank/oversized/structured names and attempted email or role updates',async()=>{
 for(const body of [{firstName:' ',lastName:'Name'},{firstName:[],lastName:'Name'},{firstName:'a'.repeat(101),lastName:'Name'},{firstName:'Name',lastName:'Test',email:'other@example.com'},{firstName:'Name',lastName:'Test',role:'ADMIN'}]){
  const res=response();await profile.updateProfile(request(body),res);assert.equal(res.statusCode,400);
 }
});
test('profile trims names, scopes live auth version, and returns only public fields',async()=>{
 mock.method(User,'findOneAndUpdate',(filter,update)=>{
  assert.equal(filter._id,user._id);assert.equal(filter.deletedAt,null);assert.deepEqual(filter.authVersion,{$in:[0,null]});
  assert.deepEqual(update,{$set:{firstName:'New',lastName:'Name'}});return query({...user,...update.$set});
 });
 const res=response();await profile.updateProfile(request({firstName:' New ',lastName:' Name '}),res);
 assert.equal(res.body.data.user.firstName,'New');assert.equal(res.body.data.user.password,undefined);
});
test('profile cannot recreate a deleted account or overwrite a changed session version',async()=>{
 mock.method(User,'findOneAndUpdate',()=>query(null));const res=response();await profile.updateProfile(request({firstName:'New',lastName:'Name'}),res);assert.equal(res.statusCode,409);
});
test('email change requires the current password before inspecting another email',async()=>{
 mock.method(User,'findOne',()=>query(user));mock.method(bcrypt,'compare',async()=>false);
 mock.method(User,'exists',()=>{throw Error('must not check');});const res=response();
 await profile.requestEmailChange(request({email:'new@example.com',password:'wrong'}),res);assert.equal(res.statusCode,400);
});
test('email change validates email/password and rejects unchanged address',async()=>{
 for(const body of [{email:'bad',password:'password'},{email:{},password:'password'},{email:'new@example.com',password:''},{email:user.email,password:'password'}]){
  const res=response();await profile.requestEmailChange(request(body),res);assert.equal(res.statusCode,400);
 }
});
test('email verification uses a keyed hash, account cooldown and 15-minute expiry without changing email',async()=>{
 setupRequest();let code,fields;
 mock.method(User,'findOneAndUpdate',(filter,update)=>{
  assert.equal(filter.password,user.password);assert.ok(filter.$or);fields=update.$set.emailChange;
  assert.equal(update.$set.email,undefined);assert.equal(fields.email,'new@example.com');assert.equal(fields.attempts,0);
  assert.equal(fields.expiresAt-fields.requestedAt,15*60000);return query(user);
 });
 mock.method(delivery,'sendEmailChangeCode',async(email,value)=>{assert.equal(email,'new@example.com');code=value;});
 const res=response();await profile.requestEmailChange(request({email:' NEW@example.com ',password:'password'}),res);
 assert.equal(res.statusCode,200);assert.match(code,/^\d{8}$/);assert.equal(fields.codeHash,profile.codeHash(user._id,'new@example.com',code));
 assert.equal(JSON.stringify(res.body).includes(code),false);
});
test('existing email, cooldown and unconfigured provider cannot issue usable codes',async()=>{
 setupRequest();mock.method(User,'exists',async()=>({_id:'other'}));let res=response();
 await profile.requestEmailChange(request({email:'new@example.com',password:'password'}),res);assert.equal(res.statusCode,409);
 mock.method(User,'exists',async()=>null);mock.method(delivery,'isConfigured',()=>false);res=response();
 await profile.requestEmailChange(request({email:'new@example.com',password:'password'}),res);assert.equal(res.statusCode,503);
 mock.method(delivery,'isConfigured',()=>true);mock.method(User,'findOneAndUpdate',()=>query(null));res=response();
 await profile.requestEmailChange(request({email:'new@example.com',password:'password'}),res);assert.equal(res.statusCode,429);
});
test('known email delivery failures remove only their issued code',async()=>{
 setupRequest();let hash;mock.method(User,'findOneAndUpdate',(_filter,update)=>{hash=update.$set.emailChange.codeHash;return query(user);});
 mock.method(delivery,'sendEmailChangeCode',async()=>{throw Error('rejected');});
 mock.method(User,'updateOne',async(filter,update)=>{assert.equal(filter['emailChange.codeHash'],hash);assert.deepEqual(update,{$unset:{emailChange:1}});});
 const res=response();await profile.requestEmailChange(request({email:'new@example.com',password:'password'}),res);assert.equal(res.statusCode,503);
});
test('verification atomically consumes the code, changes email, revokes old sessions and resets reset codes',async()=>{
 const code='01234567',email='new@example.com',hash=profile.codeHash(user._id,email,code);let calls=0;
 mock.method(User,'findOneAndUpdate',(filter,update)=>{
  calls++;
  if(calls===1){assert.equal(filter['emailChange.attempts'].$lt,5);assert.equal(filter['emailChange.authVersion'],0);assert.equal(update.$inc['emailChange.attempts'],1);return query({...user,emailChange:{codeHash:hash}});}
  assert.equal(filter['emailChange.codeHash'],hash);assert.ok(filter['emailChange.expiresAt'].$gt instanceof Date);
  assert.deepEqual(update,{$set:{email},$inc:{authVersion:1},$unset:{emailChange:1,passwordReset:1}});
  return query({...user,email,authVersion:1});
 });
 const res=response();await profile.confirmEmailChange(request({email,code}),res);assert.equal(res.statusCode,200);
 assert.equal(jwt.verify(res.body.data.token,process.env.JWT_SECRET).authVersion,1);assert.equal(res.body.data.user.password,undefined);
});
test('expired, used or exhausted codes and wrong guesses cannot reach the email write',async()=>{
 let calls=0;mock.method(User,'findOneAndUpdate',()=>{calls++;return query(null);});
 const res=response();await profile.confirmEmailChange(request({email:'new@example.com',code:'00000000'}),res);assert.equal(res.statusCode,400);assert.equal(calls,1);
 mock.method(User,'findOneAndUpdate',()=>query({...user,emailChange:{codeHash:'a'.repeat(64)}}));
 const wrong=response();await profile.confirmEmailChange(request({email:'new@example.com',code:'00000000'}),wrong);assert.equal(wrong.statusCode,400);
});
test('a losing confirmation race or duplicate-email race cannot overwrite identity',async()=>{
 for(const duplicate of [false,true]){
  let calls=0;const email='new@example.com',code='12345678';
  mock.method(User,'findOneAndUpdate',()=>{
   if(++calls===1)return query({...user,emailChange:{codeHash:profile.codeHash(user._id,email,code)}});
   if(duplicate)throw Object.assign(Error('duplicate'),{code:11000});return query(null);
  });
  const res=response();await profile.confirmEmailChange(request({email,code}),res);assert.equal(res.statusCode,duplicate?409:400);
 }
});
test('deleted accounts are rejected even by a currently signed token',async()=>{
 const token=jwt.sign({userId:user._id,authVersion:0},process.env.JWT_SECRET,{expiresIn:'5m'});
 mock.method(Revoked,'exists',async()=>null);mock.method(User,'findById',()=>query({...user,deletedAt:new Date()}));
 const res=response();let next=false;await protect({headers:{authorization:`Bearer ${token}`}},res,()=>{next=true;});assert.equal(res.statusCode,401);assert.equal(next,false);
});

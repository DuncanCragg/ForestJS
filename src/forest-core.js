
import _ from 'lodash';

const debug = false;

const notifyUID = makeUID(true);

const localProps = ['Notifying', 'Alerted', 'Timer', 'TimerId', 'Evaluator', 'ReactNotify', 'userState'];

function makeUID(notify){
  /*jshint bitwise:false */
  var i, random;
  var uuid = '';
  for (i = 0; i < 32; i++) {
    random = Math.random() * 16 | 0;
    if (i === 8 || i === 12 || i === 16 || i === 20) uuid += '-';
    uuid += (i === 12 ? 4 : (i === 16 ? (random & 3 | 8) : random)).toString(16);
  }
  return (!notify? 'uid-': 'ntf-') + uuid;
}

function difference(a, b) {
  function changes(a, b) {
    return _.transform(b, function(result, value, key) {
      if (!_.isEqual(value, a[key])) {
        result[key] = (_.isObject(value) && _.isObject(a[key])) ? changes(value, a[key]) : value;
      }
    });
  }
  return changes(a, b);
}

let persistence = null;
let network = null;

function setPersistence(p){ persistence = p; }

function setNetwork(n){ network = n; }

const objects = {};

function getCachedObject(u){
  return objects[toUID(u)]
}

function getObject(u){
  const uid=toUID(u);
  const o = objects[uid]
  if(o || !(persistence && persistence.fetch)) return Promise.resolve(o)
  return persistence.fetch(uid).then(o=>{
    objects[uid] = o;
    return o
  })
}

function cacheAndPersist(o){
  objects[toUID(o.UID)]=o;
  if(persistence && persistence.persist) persistence.persist(o);
}

function dumpCache(){
  console.log("---------cache-------");
  Object.keys(objects).map(k => console.log(objects[k]));
  console.log("---------------------");
}

function spawnObject(o){
  const UID = o.UID || makeUID();
  const Notify = o.Notify || [];
  cacheAndPersist(Object.assign({ UID, Notify }, o));
  doEvaluate(UID);
  return UID;
}

function cacheObjects(list){
  return list.map(o => spawnObject(o));
}

var fetching = {};

function ensureObjectState(u, obsuid){
  const o = getCachedObject(u);
  if(o){
    // if(isURL(u) && o.timeSinceFetched < ..){ // and below after getObject
    setNotify(o,obsuid);
    return o;
  }
  getObject(u).then(o=>{
    if(o){
      setNotify(o,obsuid);
      //notifyObservers(o);
    }
    else if(isURL(u)){
      const url=u;
      cacheAndPersist({ UID: url, Notify: [ obsuid ], Remote: url });
      if(!fetching[url]){
        fetching[url]=true;
        network && network.doGet(url)
         .then(json => { fetching[url]=false; updateObject(url, json) });
      }
    }
  })
  return null;
}

function setNotify(o,uid,savelater){
  if(!o.Notify.find(n=>valMatch(n,uid))){
    o.Notify.push(uid);
    if(!savelater) cacheAndPersist(o)
  }
}

function isRemote(uid){
  return getObject(uid).then(o=>o && o.Remote)
}

function notifyObservers(o){
  if(o.Notifying){
    setNotify(o, o.Notifying);
  }
  const remotes = {};
  Promise.all(o.Notify.map(u => getObject(u).then(n=>{
    if(!n){
      if(isURL(u) || isNotify(u)){
        network && network.doPost(Object.assign({}, o, { Notify: [u] }), u);  // TODO: !dropping o.Notify entries..
      }
    }
    else {
      if(n.Remote){
        if(!remotes[n.Remote]) remotes[n.Remote]=[n.UID]
        else                   remotes[n.Remote].concat(n.UID)
      }
      else {
        n.Alerted=o.UID;
        doEvaluate(n.UID);
        delete n.Alerted;
      }
    }})
    .catch(e => console.log(e))
  ))
  .then(()=>Object.keys(remotes).map(r => network && network.doPost(Object.assign({}, o, { Notify: remotes[r] }), r)));
}

function incomingObject(json, notify){
  if(!json.Notify) json.Notify=[]
  if(notify) setNotify(json, notify, true);
  getObject(json.UID).then(o=>{
    if(!o) storeObject(json);
    else updateObject(json.UID, json)
  })
}

function storeObject(o){
  if(!o.UID)    return;
  if(!o.Notify) o.Notify = [];
  cacheAndPersist(o);
  notifyObservers(o);
}

function updateObject(uid, update){
  if(!uid) return null
  const o=getCachedObject(uid)
  if(!o) return null;
  const p = Object.assign({}, o, update);
  const changed = !_.isEqual(o, p);
  if(!changed) return null;
  if(debug) console.log(uid, 'changed: ', difference(o, p))
  cacheAndPersist(p);
  notifyObservers(p);
  return p;
}

function isUID(u){
  return /^uid-/.test(u);
}

function isURL(u){
  return /^https?:\/\//.test(u);
}

function isNotify(u){
  return /^ntf-/.test(u);
}

function toUID(u){
  if(!isURL(u)) return u;
  const s=u.indexOf('uid-');
  if(s=== -1) return u;
  return u.substring(s);
}

const isQueryableCacheListLabels = ['queryable', 'cache', 'list'];

function cacheQuery(o, path, query){
  if(!persistence) return new Promise();
  const scope = o.list;
  if(scope.includes('local') || scope.includes('remote')){
    return persistence.query(o.is.filter(s => !isQueryableCacheListLabels.includes(s)), scope, query);
  }
  return new Promise();
}

function object(u,p,q) { const r = ((uid, path, query)=>{
  if(!uid || !path) return null;
  const o=getCachedObject(uid)
  if(!o) return null;
  const isQueryableCacheList = o.is && o.is.constructor===Array && isQueryableCacheListLabels.every(s => o.is.includes(s));
  const hasMatch = query && query.constructor===Object && query.match
  if(path==='list' && isQueryableCacheList && hasMatch) return cacheQuery(o, path, query);
  if(path==='.') return o;
  const pathbits = path.split('.');
  let c=o;
  for(var i=0; i<pathbits.length; i++){
    if(pathbits[i]==='') return c;
    if(pathbits[i]==='Timer') return c.Timer || 0;
    const val = c[pathbits[i]];
    if(val == null) return null;
    if(i==pathbits.length-1){
      if(!hasMatch) return val;
      if(val.constructor === Array){
        if(query.match.constructor===Array){
          return (query.match.length <= val.length && query.match.every(q => val.find(v=>valMatch(q,v))) && val) || null;
        }
        const r = val.filter(v => {
          if(valMatch(v, query.match)) return true;
          if(v.constructor === String){
            // TODO: ensureObjectState?
            const o=getCachedObject(v)
            if(!o) return false;
            setNotify(o,uid); // TODO: don't do that when it needn't observe: String:String case, UID:, etc
            return Object.keys(query.match).every(k => valMatch(o[k], query.match[k]));
          }
          if(v.constructor===Object){
            return Object.keys(query.match).every(k => valMatch(v[k],query.match[k]));
          }
          return false;
        });
        return (r.length && r) || null;
      }
      return valMatch(val,query.match)? val: null;
    }
    if(val.constructor === Object){ c = val; continue; }
    if(val.constructor === String){
      c = ensureObjectState(val, uid);
      if(!c) return null;
    }
  }
  })(u,p,q);
  // if(debug) console.log('object',getCachedObject(u),'path',p,'query',q,'=>',r);
  return r;
}

function valMatch(a, b){
  return a == b || ((isURL(a) || isURL(b)) && toUID(a) === toUID(b));
}

function checkTimer(o,time){
  if(time && time > 0 && !o.TimerId){
    o.TimerId = setTimeout(() => {
      getCachedObject(o.UID).TimerId = null;
      updateObject(o.UID, { Timer: 0 });
      doEvaluate(o.UID);
    }, time);
  }
}

function setPromiseState(uid, o, p){
  p.then(newState => {
    if(debug) console.log('<<<<<<<<<<<<< promised update: ', newState);
    checkTimer(o,newState.Timer);
    updateObject(uid, newState);
  });
  return {};
}

function doEvaluate(uid, params) {
  var o = getCachedObject(uid);
  if(!o || !o.Evaluator || typeof o.Evaluator !== 'function') return o;
  const reactnotify = o.ReactNotify;
  for(var i=0; i<4; i++){
    if(debug) console.log(i, '>>>>>>>>>>>>> ', object(uid, '.'));
    if(debug && object(uid, 'userState.')) console.log(i, '>>>>>>>>>>>>> ', object(uid, 'userState.'));
    const evalout = o.Evaluator(object.bind(null, uid), params);
    if(!evalout){ console.error('no eval output for', uid, o); return o; }
    let newState;
    if(evalout.constructor === Array){
      newState = Object.assign({}, ...(evalout.map(x => (x && x.constructor === Promise)? setPromiseState(uid,o,x): (x || {}))))
    }
    else newState = evalout;
    if(debug) console.log(i, '<<<<<<<<<<<<< update: ', newState);
    checkTimer(o,newState.Timer);
    o = updateObject(uid, newState);
    if(!o) break;
  }
  if(reactnotify) reactnotify();
  return o;
}

function runEvaluator(uid, params){
  return getObject(uid).then(()=>doEvaluate(uid, params));
}

export default {
  notifyUID,
  toUID,
  spawnObject,
  storeObject,
  cacheObjects,
  setNotify,
  updateObject,
  incomingObject,
  object,
  runEvaluator,
  getObject,
  setPersistence,
  setNetwork,
  localProps,
  isURL,
  isNotify,
}


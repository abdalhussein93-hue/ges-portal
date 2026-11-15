'use strict';
/**
 * Building blocks shared by the app definitions.
 *
 * An app definition has:
 *   id, name, description, icon, color      shown on the portal home page
 *   path                                    URL of the app, e.g. "/camp/"
 *   textMode                                'strict' | 'markup' (see text.js)
 *   seedFile                                optional starting data file name in seed/
 *   files                                   files the app may store: {name: {maxBytes, writeRole}}
 *   isRootKey(key)                          is this a valid top-level section of the document?
 *   checkPermission(role, op)               null if allowed, else a message for the user
 *   filterDoc(doc, role) / filterOps(ops, role)   remove what a role may not see
 *   normalise(doc)                          fix data in place after a change; returns the top-level
 *                                           sections it changed (empty array = nothing)
 *   importDocument(fileContent)             turn an uploaded desktop data file into a document
 */

/** Viewers read only; operators and admins may change everything inside the app. */
function editorsMayChangeAll(role) {
  if (role === 'admin' || role === 'operator') return null;
  return 'Your account can only view this app.';
}

const identity = x => x;
const noNormalise = () => [];

function defineApp(def) {
  const app = Object.assign({
    textMode: 'markup',
    seedFile: null,
    files: {},
    filterDoc: identity,
    filterOps: identity,
    normalise: noNormalise,
    checkPermission: editorsMayChangeAll,
  }, def);
  for (const k of ['id', 'name', 'path', 'isRootKey', 'importDocument']) {
    if (!app[k]) throw new Error(`App definition is missing "${k}"`);
  }
  return Object.freeze(app);
}

/** Error whose message can be shown to the user as is. */
class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; this.expose = true; }
}

module.exports = { defineApp, editorsMayChangeAll, UserError };

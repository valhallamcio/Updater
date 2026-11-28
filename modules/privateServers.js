/**
 * Private servers. Bifrost's server-matcher makes a server private with
 * accessGate { kind: 'allowlist', uuids } on its bifrost.servers doc. Only its
 * members may know it exists, so no public Discord list names it.
 * Yggdrasil sends the flag as isPrivate on keyed /servers reads.
 */

function isPrivateServer(server) {
    if (!server) return false;
    if (server.isPrivate === true) return true;
    const gate = server.accessGate;
    return !!gate && typeof gate === 'object' && gate.kind === 'allowlist';
}

/** The servers without the private ones. A new array, the docs are shared. */
function publicServers(servers) {
    return (servers || []).filter(s => !isPrivateServer(s));
}

module.exports = { isPrivateServer, publicServers };

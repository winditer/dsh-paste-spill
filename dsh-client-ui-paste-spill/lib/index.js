/**
 * dsh-client-ui-paste-spill node half. Pure UI plugin: the empty apply exists so
 * the package appears in the host loader (load and lifecycle follow the host);
 * the browser half ships via exports["./client"], discovered through the
 * package.json dsh.client declaration. Same shape as dsh-message-rail.
 */
export function apply() {}
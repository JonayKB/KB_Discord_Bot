import { createContext, useContext } from 'react';
import type { Me } from './api';

export const AccessContext = createContext<Me['access']>('staff');

/** Solo decide qué se muestra: el servidor es quien aplica los permisos. */
export const useIsOwner = () => useContext(AccessContext) === 'owner';

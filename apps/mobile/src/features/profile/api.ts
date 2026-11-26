import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AuthSessionSchema,
  AvatarUploadUrlSchema,
  type ChangePasswordRequest,
  type NotificationPreference,
  NotificationPreferencesSchema,
  type Profile,
  ProfileSchema,
  type UpdateProfileRequest,
} from '@tw/contracts';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { ApiError } from '../../shared/api/http';
import { queryKeys, useSubjectId } from '../../shared/api/queryKeys';
import { sessionController, useSessionStore } from '../../shared/auth/session';

function requireSubject(subjectId: string | null): string {
  if (!subjectId) throw new ApiError('UNAUTHENTICATED', 401, 'Not signed in');
  return subjectId;
}

export function useProfile() {
  const subjectId = useSubjectId();
  return useQuery({
    queryKey: queryKeys.profile(subjectId ?? 'none'),
    enabled: subjectId !== null,
    queryFn: () =>
      sessionController.request({ method: 'GET', path: '/me/profile', schema: ProfileSchema }),
  });
}

/** Keeps the session user (name, language) in step with profile changes. */
function syncSessionUser(profile: Profile): void {
  const current = useSessionStore.getState().user;
  if (current?.id === profile.id) {
    useSessionStore.setState({
      user: {
        ...current,
        firstName: profile.firstName,
        lastName: profile.lastName,
        preferredLanguage: profile.preferredLanguage,
      },
    });
  }
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();
  const subjectId = useSubjectId();
  return useMutation({
    mutationFn: (input: UpdateProfileRequest) =>
      sessionController.request({
        method: 'PATCH',
        path: '/me/profile',
        body: input,
        schema: ProfileSchema,
      }),
    onSuccess: (profile) => {
      queryClient.setQueryData(queryKeys.profile(requireSubject(subjectId)), profile);
      syncSessionUser(profile);
    },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: async (input: ChangePasswordRequest) => {
      const session = await sessionController.request({
        method: 'PATCH',
        path: '/me/password',
        body: input,
        schema: AuthSessionSchema,
      });
      // Every other session was revoked; continue with the fresh one on this device.
      await sessionController.adoptSession(session);
    },
  });
}

export function useNotificationPreferences() {
  const subjectId = useSubjectId();
  return useQuery({
    queryKey: queryKeys.preferences(subjectId ?? 'none'),
    enabled: subjectId !== null,
    queryFn: () =>
      sessionController.request({
        method: 'GET',
        path: '/me/notification-preferences',
        schema: NotificationPreferencesSchema,
      }),
  });
}

export function useUpdateNotificationPreference() {
  const queryClient = useQueryClient();
  const subjectId = useSubjectId();
  return useMutation({
    mutationFn: (preference: NotificationPreference) =>
      sessionController.request({
        method: 'PUT',
        path: '/me/notification-preferences',
        body: [preference],
        schema: NotificationPreferencesSchema,
      }),
    onSuccess: (preferences) => {
      queryClient.setQueryData(queryKeys.preferences(requireSubject(subjectId)), preferences);
    },
  });
}

const AVATAR_SIZE_PX = 512;

export class AvatarPermissionError extends Error {
  override readonly name = 'AvatarPermissionError';
}

/**
 * Pick → square-crop → resize to 512px JPEG → presigned upload → confirm.
 * Resolves null when the user cancels the picker.
 */
export function useChangeAvatar() {
  const queryClient = useQueryClient();
  const subjectId = useSubjectId();
  return useMutation({
    mutationFn: async (): Promise<Profile | null> => {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) throw new AvatarPermissionError('Photo library access denied');

      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 1,
      });
      const asset = picked.canceled ? undefined : picked.assets[0];
      if (!asset) return null;

      const rendered = await ImageManipulator.manipulate(asset.uri)
        .resize({ width: AVATAR_SIZE_PX })
        .renderAsync();
      const image = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.8 });
      const blob = await (await fetch(image.uri)).blob();

      const upload = await sessionController.request({
        method: 'POST',
        path: '/me/avatar/upload-url',
        body: { contentType: 'image/jpeg', sizeBytes: blob.size },
        schema: AvatarUploadUrlSchema,
      });
      const put = await fetch(upload.uploadUrl, {
        method: 'PUT',
        headers: upload.headers,
        body: blob,
      });
      if (!put.ok) throw new ApiError('SERVICE_UNAVAILABLE', put.status, 'Upload failed');

      return sessionController.request({
        method: 'PUT',
        path: '/me/avatar',
        body: { objectKey: upload.objectKey },
        schema: ProfileSchema,
      });
    },
    onSuccess: (profile) => {
      if (profile) queryClient.setQueryData(queryKeys.profile(requireSubject(subjectId)), profile);
    },
  });
}

export function useRemoveAvatar() {
  const queryClient = useQueryClient();
  const subjectId = useSubjectId();
  return useMutation({
    mutationFn: () =>
      sessionController.request({ method: 'DELETE', path: '/me/avatar', schema: ProfileSchema }),
    onSuccess: (profile) => {
      queryClient.setQueryData(queryKeys.profile(requireSubject(subjectId)), profile);
    },
  });
}

export function useDeleteAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (password: string) => {
      await sessionController.request({ method: 'DELETE', path: '/me', body: { password } });
      await sessionController.endLocalSession();
      queryClient.clear();
    },
  });
}

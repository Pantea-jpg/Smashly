import type { NativeStackScreenProps } from '@react-navigation/native-stack';

export type AdminTrainingsParamList = {
  AdminTrainingsList: undefined;
  TrainingForm: { trainingId?: string };
  AdminTrainingDetail: { trainingId: string };
  Reservations: { trainingId: string };
  Prices: { trainingId: string };
  PriceOverride: {
    trainingId: string;
    userId: string;
    name: string;
    priceMinor: number;
    isOverride: boolean;
  };
  Attendance: { trainingId: string };
  Correction: { trainingId: string; userId: string; name: string };
  CancelTraining: { trainingId: string; finalized: boolean };
  AttendanceQueue: undefined;
};

export type AdminTrainingsProps<T extends keyof AdminTrainingsParamList> = NativeStackScreenProps<
  AdminTrainingsParamList,
  T
>;

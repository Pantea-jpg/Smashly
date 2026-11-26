import { type Control, Controller, type FieldPath, type FieldValues } from 'react-hook-form';
import { useValidationMessage } from '../i18n/useErrorMessage';
import { TextField, type TextFieldProps } from './TextField';

type FormTextFieldProps<TInput extends FieldValues, TOutput extends FieldValues> = Omit<
  TextFieldProps,
  'value' | 'onChangeText' | 'onBlur' | 'error'
> & {
  /** Input and parsed-output types may differ (Zod transforms, e.g. "" → undefined). */
  control: Control<TInput, unknown, TOutput>;
  name: FieldPath<TInput>;
};

/** TextField bound to react-hook-form, with translated Zod validation messages. */
export function FormTextField<TInput extends FieldValues, TOutput extends FieldValues = TInput>({
  control,
  name,
  ...props
}: FormTextFieldProps<TInput, TOutput>) {
  const translate = useValidationMessage();
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <TextField
          {...props}
          testID={props.testID ?? `field-${name}`}
          value={typeof field.value === 'string' ? field.value : ''}
          onChangeText={field.onChange}
          onBlur={field.onBlur}
          error={translate(fieldState.error?.message)}
        />
      )}
    />
  );
}
